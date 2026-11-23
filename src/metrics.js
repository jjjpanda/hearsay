import { TYPES, activeMaker } from './strategies.js';
import { atOrBefore } from './clock.js';
import { ENGINE_CONFIG } from './model.js';

export function marketMetrics(market, book = market.book()) {
  const mid = market.mid();
  const spreadTicks = book.bid !== null && book.ask !== null ? book.ask - book.bid : null;
  const spreadBps = spreadTicks !== null && mid > 0 ? (spreadTicks / mid) * 10000 : null;
  const totalDepth = book.buyDepth + book.sellDepth;
  const imbalance = totalDepth > 0 ? (book.buyDepth - book.sellDepth) / totalDepth : 0;
  const valueGapTicks = market.price - market.value;
  const valueGapBps = market.value > 0 ? (valueGapTicks / market.value) * 10000 : 0;
  const ofi = market.flow.total > 0 ? (market.flow.buys - market.flow.sells) / market.flow.total : 0;
  const informedShare = market.flow.total > 0 ? market.flow.byOrigin.informed / market.flow.total : 0;

  return {
    mid,
    spreadTicks,
    spreadBps,
    imbalance,
    valueGapTicks,
    valueGapBps,
    ofi,
    informedShare
  };
}

export function strategyMetrics(market) {
  const latestEvent = market.events.at(-1);
  const byType = Object.fromEntries(
    TYPES.map(type => [
      type,
      {
        type,
        count: 0,
        active: 0,
        initialWealth: 0,
        mtmWealth: 0,
        pnl: 0,
        edge: 0,
        pnlBps: 0,
        invDelta: 0,
        filled: 0,
        informed: 0,
        early: 0
      }
    ])
  );

  for (const agent of market.agents) {
    const row = byType[agent.type];
    const mtm = agent.cash + agent.shares * market.price;
    row.count++;
    if (agent.type !== 'maker' || activeMaker(market, agent)) row.active++;
    row.initialWealth += agent.initialWealth;
    row.mtmWealth += mtm;
    row.pnl += mtm - agent.initialWealth;
    row.edge += tradingEdge(market, agent);
    row.invDelta += agent.shares - agent.initialShares;
    row.filled += agent.filled;
    if (latestEvent && (agent.receivedEpisodeId === latestEvent.id || market.timeMs >= latestEvent.releaseMs)) {
      row.informed++;
    }
    if (heardEarly(agent, latestEvent)) row.early++;
  }

  for (const row of Object.values(byType)) {
    row.pnlBps = row.initialWealth > 0 ? (row.pnl / row.initialWealth) * 10000 : 0;
  }

  return byType;
}

export const tradingEdge = (market, agent) =>
  agent.cash + agent.shares * market.price - agent.initialWealth - agent.initialShares * (market.price - ENGINE_CONFIG.INITIAL_PRICE);

export const strategyEdges = market => {
  const edge = Object.fromEntries(TYPES.map(type => [type, 0]));
  for (const agent of market.agents) edge[agent.type] += tradingEdge(market, agent);
  return edge;
};

const heardEarly = (agent, event) =>
  Boolean(event) && agent.signal?.episodeId === event.id && agent.signal.receivedMs < event.releaseMs;

export function insiderMetrics(market) {
  const event = market.events.at(-1);
  if (!event) return null;
  const groups = { early: { count: 0, edge: 0, initialWealth: 0 }, late: { count: 0, edge: 0, initialWealth: 0 } };
  for (const agent of market.agents) {
    const group = groups[heardEarly(agent, event) ? 'early' : 'late'];
    group.count++;
    group.edge += tradingEdge(market, agent);
    group.initialWealth += agent.initialWealth;
  }
  return groups;
}

export function agentMetrics(market, agent) {
  const mtmWealth = agent.cash + agent.shares * market.price;
  const pnl = mtmWealth - agent.initialWealth;
  const pnlPct = agent.initialWealth > 0 ? (pnl / agent.initialWealth) * 100 : 0;
  const pnlBps = pnlPct * 100;
  const invDelta = agent.shares - agent.initialShares;
  return { mtmWealth, pnl, pnlPct, pnlBps, invDelta, filled: agent.filled };
}

export function episodeDiscovery(market, event) {
  if (!event) return null;
  const startPoint = atOrBefore(market.priceHistory, event.startMs);
  const p0 = event.startPrice ?? (startPoint ? startPoint.price : market.price);
  const targetGap = event.value - p0;
  const endMs = Math.min(market.timeMs, event.releaseMs);
  const endPoint = market.timeMs < event.releaseMs
    ? { price: market.price }
    : atOrBefore(market.priceHistory, event.releaseMs);
  const pEnd = endPoint ? endPoint.price : market.price;

  const discovery = Math.abs(targetGap) >= 1 ? ((pEnd - p0) / targetGap) * 100 : null;

  const trajectory = [];
  if (Math.abs(targetGap) >= 1 && market.timeMs >= event.startMs) {
    trajectory.push({ seconds: 0, ratio: 0 });
    for (const point of market.priceHistory) {
      if (point.timeMs < event.startMs || point.timeMs > endMs) continue;
      const seconds = (point.timeMs - event.startMs) / 1000;
      const ratio = (point.price - p0) / targetGap;
      if (seconds === 0 && ratio === 0) continue;
      trajectory.push({ seconds, ratio });
    }
    if (market.timeMs <= event.releaseMs) {
      const nowSec = (market.timeMs - event.startMs) / 1000;
      const nowRatio = (market.price - p0) / targetGap;
      const last = trajectory.at(-1);
      if (last.seconds === nowSec && nowSec > 0) {
        last.ratio = nowRatio;
      } else if (last.seconds !== nowSec || last.ratio !== nowRatio) {
        trajectory.push({ seconds: nowSec, ratio: nowRatio });
      }
    }
  }

  return {
    p0,
    pEnd,
    targetGap,
    discoveryPct: discovery,
    trajectory
  };
}

export function counterpartyMatrix(market) {
  const index = Object.fromEntries(TYPES.map((t, i) => [t, i]));
  const size = TYPES.length;
  const volume = Array.from({ length: size }, () => Array(size).fill(0));
  const count = Array.from({ length: size }, () => Array(size).fill(0));
  let maxVolume = 0;

  for (const t of market.trades) {
    const aggressorId = t.side === 'buy' ? t.buyer : t.seller;
    const passiveId = t.side === 'buy' ? t.seller : t.buyer;
    const row = index[market.agents[aggressorId]?.type];
    const col = index[market.agents[passiveId]?.type];
    if (row === undefined || col === undefined) continue;
    volume[row][col] += t.qty;
    count[row][col]++;
    if (volume[row][col] > maxVolume) maxVolume = volume[row][col];
  }

  return { types: TYPES, volume, count, maxVolume };
}
