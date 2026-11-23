import { recordExecution } from './analytics.js';

export const ORDER_TTL_MS = 12000;
export const RECENT_TRADE_KEEP = 500;

function aggregateDepthLevels(sortedOrders) {
  const levels = [];
  for (const order of sortedOrders) {
    const lastLevel = levels.at(-1);
    if (lastLevel && lastLevel.price === order.price) {
      lastLevel.qty += order.qty;
    } else {
      levels.push({ price: order.price, qty: order.qty });
    }
  }
  return levels;
}

export class Exchange {
  constructor(market) {
    this.market = market;
    this.cachedBook = null;
    this.bids = [];
    this.asks = [];
    this.buyDepth = 0;
    this.sellDepth = 0;
    this.byAgent = new Map();
  }

  invalidate() {
    this.cachedBook = null;
  }

  bestBid() {
    return this.bids[0]?.price ?? null;
  }

  bestAsk() {
    return this.asks[0]?.price ?? null;
  }

  agentOrderCount(agentId) {
    return this.byAgent.get(agentId)?.size ?? 0;
  }

  bestPriceExcluding(side, agentId) {
    const queue = side === 'buy' ? this.bids : this.asks;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].agent !== agentId) return queue[i].price;
    }
    return null;
  }

  topSize(queue) {
    if (!queue.length) return null;
    const topPrice = queue[0].price;
    let qty = 0;
    for (let i = 0; i < queue.length && queue[i].price === topPrice; i++) {
      qty += queue[i].qty;
    }
    return qty;
  }

  insertOrder(order) {
    const isBuy = order.side === 'buy';
    const queue = isBuy ? this.bids : this.asks;
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const cur = queue[mid];
      const after = isBuy
        ? cur.price > order.price || (cur.price === order.price && cur.id < order.id)
        : cur.price < order.price || (cur.price === order.price && cur.id < order.id);
      if (after) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, order);
    this.market.orders.push(order);
    if (isBuy) this.buyDepth += order.qty;
    else this.sellDepth += order.qty;
    let set = this.byAgent.get(order.agent);
    if (!set) {
      set = new Set();
      this.byAgent.set(order.agent, set);
    }
    set.add(order);
  }

  removeOrder(order, queueIndex = -1, marketIndex = -1) {
    const isBuy = order.side === 'buy';
    const queue = isBuy ? this.bids : this.asks;
    const qIdx = queueIndex >= 0 && queue[queueIndex] === order ? queueIndex : queue.indexOf(order);
    if (qIdx >= 0) queue.splice(qIdx, 1);
    if (isBuy) this.buyDepth -= order.qty;
    else this.sellDepth -= order.qty;
    const set = this.byAgent.get(order.agent);
    if (set) {
      set.delete(order);
      if (set.size === 0) this.byAgent.delete(order.agent);
    }
    const mIdx = marketIndex >= 0 ? marketIndex : this.market.orders.indexOf(order);
    if (mIdx >= 0) this.market.orders.splice(mIdx, 1);
  }

  reassignAgent(fromId, toId) {
    const set = this.byAgent.get(fromId);
    if (!set) return;
    this.byAgent.delete(fromId);
    for (const order of set) order.agent = toId;
    this.byAgent.set(toId, set);
  }

  book() {
    if (this.cachedBook) {
      return this.cachedBook;
    }

    const bids = this.bids.slice();
    const asks = this.asks.slice();

    this.cachedBook = {
      bids,
      asks,
      bid: bids[0]?.price ?? null,
      ask: asks[0]?.price ?? null,
      buyDepth: this.buyDepth,
      sellDepth: this.sellDepth,
      buyLevels: aggregateDepthLevels(bids),
      sellLevels: aggregateDepthLevels(asks)
    };

    return this.cachedBook;
  }

  cancel(order) {
    const market = this.market;
    const index = market.orders.indexOf(order);
    if (index < 0) {
      return;
    }

    const agent = market.agents[order.agent];
    if (order.side === 'buy') {
      agent.reservedCash -= order.price * order.qty;
    } else {
      agent.reservedShares -= order.qty;
    }

    this.removeOrder(order, -1, index);
    this.invalidate();
  }

  cancelAgent(agentId) {
    const set = this.byAgent.get(agentId);
    if (!set || set.size === 0) return;
    for (const order of [...set]) {
      this.cancel(order);
    }
  }

  submit(agentId, side, limit, quantity, provenance = {}) {
    const market = this.market;
    const agent = market.agents[agentId];

    if (
      !agent ||
      (side !== 'buy' && side !== 'sell') ||
      !Number.isFinite(limit) ||
      !Number.isFinite(quantity)
    ) {
      return null;
    }

    const origin = provenance.origin ?? (agent.type === 'maker' ? 'maker' : 'baseline');
    const episodeId = provenance.episodeId ?? null;

    const isValidOrigin = origin === 'baseline' || origin === 'informed' || origin === 'maker';
    const isValidEpisode =
      origin === 'informed'
        ? Number.isSafeInteger(episodeId) && episodeId >= 1 && episodeId <= market.signalSequence
        : episodeId === null;

    if (!isValidOrigin || !isValidEpisode) {
      return null;
    }

    const price = Math.max(1, Math.round(limit));
    if (!Number.isSafeInteger(price)) {
      return null;
    }

    const availableQty =
      side === 'buy'
        ? Math.floor((agent.cash - agent.reservedCash) / price)
        : agent.shares - agent.reservedShares;

    const requestedQty = Math.floor(quantity);
    const orderQty = Math.min(requestedQty, availableQty);

    if (
      orderQty <= 0 ||
      !Number.isSafeInteger(orderQty) ||
      !Number.isSafeInteger(price * orderQty)
    ) {
      return null;
    }

    const order = {
      id: market.nextOrder++,
      agent: agentId,
      side,
      price,
      qty: orderQty,
      timeMs: market.timeMs,
      expiresAtMs: market.timeMs + ORDER_TTL_MS,
      origin,
      episodeId
    };

    market.diagnostics.submitted[origin]++;

    if (side === 'buy') {
      agent.reservedCash += price * orderQty;
    } else {
      agent.reservedShares += orderQty;
    }

    const opposingQueue = side === 'buy' ? this.asks : this.bids;
    const opposingPrice = opposingQueue[0]?.price ?? null;
    const canCross = opposingPrice !== null && (side === 'buy' ? opposingPrice <= price : opposingPrice >= price);
    const quote = canCross
      ? {
          bid: this.bids[0]?.price ?? null,
          bidSize: this.topSize(this.bids),
          ask: this.asks[0]?.price ?? null,
          askSize: this.topSize(this.asks)
        }
      : null;

    let i = 0;
    while (canCross && order.qty > 0 && i < opposingQueue.length) {
      const resting = opposingQueue[i];
      const crossed = side === 'buy' ? resting.price <= price : resting.price >= price;
      if (!crossed) {
        break;
      }

      if (resting.agent === agentId) {
        i++;
        continue;
      }

      const matchSize = Math.min(order.qty, resting.qty);
      const buyerOrder = side === 'buy' ? order : resting;
      const sellerOrder = side === 'sell' ? order : resting;
      const buyer = market.agents[buyerOrder.agent];
      const seller = market.agents[sellerOrder.agent];

      const executionPrice = resting.price;
      const settlementCost = executionPrice * matchSize;

      buyer.reservedCash -= buyerOrder.price * matchSize;
      seller.reservedShares -= matchSize;

      buyer.cash -= settlementCost;
      seller.cash += settlementCost;
      buyer.shares += matchSize;
      seller.shares -= matchSize;

      const rawFee = market.feeBps > 0 ? Math.floor((settlementCost * market.feeBps) / 10000) : 0;
      if (rawFee > 0) {
        const fee = side === 'buy' ? Math.min(rawFee, buyer.cash - buyer.reservedCash) : Math.min(rawFee, settlementCost);
        if (side === 'buy') {
          buyer.cash -= fee;
          seller.cash += fee;
        } else {
          seller.cash -= fee;
          buyer.cash += fee;
        }
      }

      market.clock.excitation = Math.min(0.8, (market.clock.excitation ?? 0) + 0.004 * matchSize);
      market.flowToxicity = Math.max(-3, Math.min(3, (market.flowToxicity ?? 0) + (side === 'buy' ? 1 : -1) * Math.min(1, matchSize / 50)));

      buyer.filled += matchSize;
      seller.filled += matchSize;
      buyer.lastTradeMs = market.timeMs;
      seller.lastTradeMs = market.timeMs;

      order.qty -= matchSize;
      resting.qty -= matchSize;
      if (side === 'buy') this.sellDepth -= matchSize;
      else this.buyDepth -= matchSize;

      market.price = executionPrice;
      market.volume += matchSize;
      market.tradeCount++;

      const trade = {
        id: market.tradeCount,
        timeMs: market.timeMs,
        buyer: buyer.id,
        seller: seller.id,
        price: executionPrice,
        qty: matchSize,
        side,
        aggressorOrderId: order.id,
        restingOrderId: resting.id,
        buyerOrderId: buyerOrder.id,
        sellerOrderId: sellerOrder.id,
        origin: order.origin,
        episodeId: order.episodeId,
        restingOrigin: resting.origin,
        restingEpisodeId: resting.episodeId,
        ...quote
      };

      market.trades.push(trade);
      recordExecution(market, trade);
      market.recordPrice();

      if (!resting.qty) {
        this.removeOrder(resting, i);
      } else {
        i++;
      }

      this.invalidate();
    }

    if (order.qty > 0) {
      this.insertOrder(order);
    }

    while (market.trades.length > RECENT_TRADE_KEEP) {
      market.trades.shift();
    }

    this.invalidate();
    return order;
  }
}
