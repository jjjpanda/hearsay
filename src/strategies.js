import { atOrBefore, clamp, uniform } from './clock.js';
import { countAttempt } from './diagnostics.js';
import { activeEpisode, isInformed } from './information.js';

export const TYPES = ['maker', 'value', 'trend', 'random'];

export const STRATEGY_CONFIG = Object.freeze({
  INVENTORY_SKEW: 40,
  PROFIT_EDGE: 2,
  SWEEP_TICKS: 10,
  ALPHA_SWEEP_SCALE: 200,
  QUOTE_HISTORY_KEEP: 121,
  TREND_LOOKBACK_MS: 5000,
  TREND_LOOKBACK_RANGE_MS: 15000,
  TREND_FAST_LOOKBACK_MS: 2000,
  TREND_FAST_RANGE_MS: 3000,
  TREND_MIN_ELAPSED_SECONDS: 1,
  TREND_HORIZON: 2,
  TREND_HORIZON_RANGE: 6,
  TREND_MAX_FORECAST: 80,
  TREND_IMBALANCE_WEIGHT: 12,
  TREND_VALUE_WEIGHT: 0.08,
  TREND_NOISE: 40,
  TREND_STRENGTH_MIN: 0.5,
  TREND_STRENGTH_RANGE: 1,
  TREND_SMOOTH_MS: 2000,
  VIEW_TAU_MS: 10000,
  VIEW_TAU_RANGE_MS: 20000,
  QUOTE_NOISE: 30,
  RANDOM_ANCHOR_TAU_MS: 5000,
  RANDOM_BIAS_WEIGHT: 1,
  RANDOM_VOLATILITY_NOISE: 4,
  MAKER_VALUE_LEAN: 12,
  MAKER_VALUE_SCALE: 60,
  MAKER_HALF_SPREAD: 6,
  MAKER_INVENTORY_SPREAD: 12,
  MAKER_UNCERTAINTY_SPREAD: 0.04,
  MAKER_TOXICITY_LEAN: 10,
  MAKER_TOXICITY_SPREAD: 2.5,
  MAKER_BASE_SIZE: 20,
  MAKER_LIQUIDITY_SIZE: 1.5,
  MAKER_MAX_SIZE_LEAN: 0.8,
  RANDOM_REACH: 24,
  NOISE_CENTER: 1.5
});
export const { PROFIT_EDGE, SWEEP_TICKS } = STRATEGY_CONFIG;
const C = STRATEGY_CONFIG;

function boundedLean(gap, maximum, scale = maximum) {
  return maximum * Math.tanh(gap / scale);
}

export function activeMaker(market, agent) {
  return agent.jitter < market.settings.liquidity / 100;
}

function inventory(agent) {
  return (agent.shares - agent.initialShares) / agent.initialShares;
}

export function inventoryEstimate(agent) {
  return Math.max(1, agent.knownValue + agent.bias - inventory(agent) * C.INVENTORY_SKEW);
}

function sampleNoise(market) {
  return (
    uniform(market.random) +
    uniform(market.random) +
    uniform(market.random) -
    C.NOISE_CENTER
  );
}

export function updateStrategies(market) {
  const referencePrice = market.mid();
  const currentObservation = { timeMs: market.timeMs, mid: referencePrice };
  if (market.quoteHistory.at(-1).timeMs === market.timeMs) {
    market.quoteHistory[market.quoteHistory.length - 1] = currentObservation;
  } else {
    market.quoteHistory.push(currentObservation);
  }

  if (market.quoteHistory.length > C.QUOTE_HISTORY_KEEP) {
    market.quoteHistory.shift();
  }

  const uncertainty = market.settings.uncertainty / 100;
  const buyDepth = market.exchange.buyDepth;
  const sellDepth = market.exchange.sellDepth;
  const depthTotal = buyDepth + sellDepth;
  const bookImbalance = depthTotal > 0 ? (buyDepth - sellDepth) / depthTotal : 0;

  const respondingMakers = [];
  for (const agent of market.agents) {
    if (market.timeMs < agent.nextResponseMs) continue;
    agent.nextResponseMs += agent.responseIntervalMs;
    if (agent.pendingTarget !== null) {
      agent.knownValue = agent.pendingTarget;
      agent.pendingTarget = null;
    }
    if (agent.type === 'maker') respondingMakers.push(agent);
    const baselineEstimate = agent.knownValue + agent.bias;
    const estimate = inventoryEstimate(agent);
    const reservationAdjustment = estimate - baselineEstimate;
    const persistence = Math.exp(-agent.responseIntervalMs / (C.VIEW_TAU_MS + agent.jitter * C.VIEW_TAU_RANGE_MS));
    agent.view = clamp(persistence * agent.view + Math.sqrt(1 - persistence ** 2) * sampleNoise(market), -C.NOISE_CENTER, C.NOISE_CENTER);

    if (agent.type === 'value') {
      agent.belief = estimate;
    } else if (agent.type === 'trend') {
      const slowLookbackMs = C.TREND_LOOKBACK_MS + agent.jitter * C.TREND_LOOKBACK_RANGE_MS;
      const fastLookbackMs = C.TREND_FAST_LOOKBACK_MS + (1 - agent.jitter) * C.TREND_FAST_RANGE_MS;
      const slowQuote = atOrBefore(market.quoteHistory, market.timeMs - slowLookbackMs);
      const fastQuote = atOrBefore(market.quoteHistory, market.timeMs - fastLookbackMs);

      const slowElapsed = Math.max(C.TREND_MIN_ELAPSED_SECONDS, (market.timeMs - slowQuote.timeMs) / 1000);
      const fastElapsed = Math.max(C.TREND_MIN_ELAPSED_SECONDS, (market.timeMs - fastQuote.timeMs) / 1000);
      const velocity = 0.6 * ((referencePrice - slowQuote.mid) / slowElapsed) + 0.4 * ((referencePrice - fastQuote.mid) / fastElapsed);
      const trendScale = market.settings.trend / 100;
      const forecastHorizon = (C.TREND_HORIZON + C.TREND_HORIZON_RANGE * agent.jitter) * trendScale;
      const strength = C.TREND_STRENGTH_MIN + agent.style * C.TREND_STRENGTH_RANGE;
      const momentumForecast = boundedLean(strength * (velocity * forecastHorizon + bookImbalance * C.TREND_IMBALANCE_WEIGHT * trendScale), C.TREND_MAX_FORECAST);
      agent.forecast += (1 - Math.exp(-agent.responseIntervalMs / C.TREND_SMOOTH_MS)) * (momentumForecast - agent.forecast);

      agent.belief =
        referencePrice +
        agent.forecast +
        (baselineEstimate - referencePrice) * C.TREND_VALUE_WEIGHT * 2 * (1 - agent.style) +
        reservationAdjustment +
        agent.view * C.TREND_NOISE * uncertainty;
    } else {
      const recentMoveTicks = market.volatility * referencePrice / 10000;
      agent.anchor += (1 - Math.exp(-agent.responseIntervalMs / C.RANDOM_ANCHOR_TAU_MS)) * (referencePrice - agent.anchor);
      agent.belief =
        agent.anchor +
        reservationAdjustment +
        agent.bias * C.RANDOM_BIAS_WEIGHT +
        agent.view * (C.QUOTE_NOISE + C.RANDOM_VOLATILITY_NOISE * recentMoveTicks) * uncertainty;
    }

    agent.belief = Math.max(1, agent.belief);
  }

  refreshMakers(market, referencePrice, respondingMakers);
}

export function refreshMakers(market, reference = market.price, makers = market.makers ?? market.agents.filter(agent => agent.type === 'maker')) {
  for (const agent of makers) {
    market.cancelAgent(agent.id);
  }

  for (const agent of makers) {
    if (!activeMaker(market, agent)) {
      continue;
    }

    const currentInventory = inventory(agent);
    const reservationAdjustment = inventoryEstimate(agent) - (agent.knownValue + agent.bias);
    const toxicity = market.flowToxicity ?? 0;
    const centerPrice =
      reference +
      boundedLean(agent.knownValue - reference, C.MAKER_VALUE_LEAN, C.MAKER_VALUE_SCALE) +
      boundedLean(toxicity * 8, C.MAKER_TOXICITY_LEAN, 16) +
      reservationAdjustment;

    const stress = Math.min(1, market.volatility / 10);
    const halfSpread = (C.MAKER_HALF_SPREAD + Math.abs(currentInventory) * C.MAKER_INVENTORY_SPREAD + market.settings.uncertainty * C.MAKER_UNCERTAINTY_SPREAD + Math.abs(toxicity) * C.MAKER_TOXICITY_SPREAD) * (1 + 2 * stress);
    const baseQuoteSize = C.MAKER_BASE_SIZE + Math.round(market.settings.liquidity * C.MAKER_LIQUIDITY_SIZE);
    const inventoryLean = clamp(currentInventory, -C.MAKER_MAX_SIZE_LEAN, C.MAKER_MAX_SIZE_LEAN);

    agent.belief = centerPrice;

    const bestAsk = market.bestAsk();
    const bidTarget = Math.round(centerPrice - halfSpread);
    const bidLimit = Math.min(bidTarget, bestAsk === null ? Infinity : bestAsk - 1);
    const bidQuantity = Math.round(baseQuoteSize * (1 - inventoryLean) * (1 - 0.75 * stress));
    market.submit(agent.id, 'buy', bidLimit, bidQuantity);

    const bestBid = market.bestBid();
    const askTarget = Math.round(centerPrice + halfSpread);
    const askLimit = Math.max(askTarget, (bestBid ?? 0) + 1);
    const askQuantity = Math.round(baseQuoteSize * (1 + inventoryLean) * (1 - 0.75 * stress));
    market.submit(agent.id, 'sell', askLimit, askQuantity);
  }
}

export function attemptCustomer(
  market,
  agent,
  size,
  direction = null,
  origin = 'baseline',
  episodeId = null
) {
  const referencePrice = market.mid();
  const preferredSide =
    agent.type === 'random'
      ? uniform(market.random) < 0.5 + (market.sentiment ?? 0)
        ? 'buy'
        : 'sell'
      : (agent.type === 'value' ? inventoryEstimate(agent) : agent.belief) >= referencePrice
        ? 'buy'
        : 'sell';

  const side = direction ?? preferredSide;

  if (origin === 'baseline' || (origin === 'informed' && !direction)) {
    countAttempt(market, origin, size, side);
  }

  const decline = reason => {
    agent.lastAction = `Declined ${origin} ${side} attempt: ${reason}`;
    return null;
  };

  if (agent.type === 'trend' && side !== preferredSide) {
    return decline('momentum points the other way');
  }

  const boundedByValue = agent.type === 'value' || (agent.type === 'trend' && isInformed(market, agent));
  const valuation = boundedByValue ? inventoryEstimate(agent) : agent.belief;
  const valueLimit =
    side === 'buy'
      ? Math.floor(valuation - PROFIT_EDGE)
      : Math.ceil(valuation + PROFIT_EDGE);

  const opposingSide = side === 'buy' ? 'sell' : 'buy';
  const bestOpposingPrice = market.exchange.bestPriceExcluding(opposingSide, agent.id);

  if (
    boundedByValue &&
    bestOpposingPrice !== null &&
    (side === 'buy' ? bestOpposingPrice > valueLimit : bestOpposingPrice < valueLimit)
  ) {
    return decline('less than two ticks of edge at the opposing quote');
  }

  const sign = side === 'buy' ? 1 : -1;
  const anchor = bestOpposingPrice ?? market.price;
  let reach = anchor + sign * SWEEP_TICKS;

  const episode = isInformed(market, agent) ? activeEpisode(market) : null;
  if (episode) {
    const elapsed = (market.timeMs - episode.startMs) / (episode.releaseMs - episode.startMs);
    const edge = bestOpposingPrice === null ? 0 : sign * (valuation - bestOpposingPrice);
    const urgency = clamp(elapsed + Math.max(0, edge - PROFIT_EDGE) / C.ALPHA_SWEEP_SCALE, 0, 1);
    const ownBest = market.exchange.bestPriceExcluding(side, agent.id);
    const passive = ownBest === null ? anchor - sign : ownBest + sign;
    const resting = bestOpposingPrice === null ? passive : sign * Math.min(sign * passive, sign * (bestOpposingPrice - sign));
    reach = Math.round(resting + urgency * (reach - resting));
  }

  const preferredLimit =
    agent.type === 'random'
      ? Math.round(referencePrice + sign * C.RANDOM_REACH)
      : valueLimit;
  let orderLimit = side === 'buy' ? Math.min(preferredLimit, reach) : Math.max(preferredLimit, reach);

  if (orderLimit < 1) {
    return decline('no positive price satisfies the value limit');
  }

  const cannotAffordBuy = side === 'buy' && agent.cash < orderLimit;
  const cannotDeliverSell = side === 'sell' && agent.shares <= 0;
  if (cannotAffordBuy || cannotDeliverSell) {
    return decline('insufficient cash or units');
  }

  market.cancelAgent(agent.id);

  const order = market.submit(agent.id, side, orderLimit, size, { origin, episodeId });
  if (!order) {
    return decline('insufficient available resources');
  }

  return order;
}
