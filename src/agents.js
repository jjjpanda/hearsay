import { uniform } from './clock.js';
import { DEFAULT_RATIOS, RATIO_KEYS, ENGINE_CONFIG as C } from './model.js';
import { refreshMakers } from './strategies.js';

export function normalizeRatios(ratios = DEFAULT_RATIOS) {
  const clean = {};
  let total = 0;
  for (const key of RATIO_KEYS) {
    const val = Number(ratios?.[key]);
    clean[key] = Number.isFinite(val) && val >= 0 ? val : 0;
    total += clean[key];
  }
  if (total <= 0) return { ...DEFAULT_RATIOS };
  return clean;
}

export function pickTypeByDraw(draw, ratios) {
  const total = RATIO_KEYS.reduce((s, k) => s + ratios[k], 0);
  let target = draw * total;
  for (const key of RATIO_KEYS) {
    target -= ratios[key];
    if (target < 0) return key;
  }
  return RATIO_KEYS[RATIO_KEYS.length - 1];
}

export function syncPools(market) {
  const customers = [];
  const makers = [];
  for (const agent of market.agents) {
    if (agent.type === 'maker') makers.push(agent);
    else customers.push(agent);
  }
  Object.defineProperty(market, 'customers', { value: customers, configurable: true });
  Object.defineProperty(market, 'makers', { value: makers, configurable: true });
}

export function createAgent(market, id, type) {
  const initialShares = C.INITIAL_SHARES + Math.floor(uniform(market.random) * C.INITIAL_SHARES_RANGE);
  const initialCash = market.price * (C.INITIAL_CASH_UNITS + Math.floor(uniform(market.random) * C.INITIAL_CASH_RANGE));
  const reach = uniform(market.random);
  return {
    id,
    type,
    cash: initialCash,
    shares: initialShares,
    initialShares,
    initialWealth: initialCash + initialShares * market.price,
    reservedCash: 0,
    reservedShares: 0,
    belief: market.price,
    knownValue: market.value,
    confidence: 0.5 + uniform(market.traits) * 0.5,
    responseIntervalMs: 250 * (1 + Math.floor(uniform(market.traits) * 6)),
    nextResponseMs: market.timeMs + 250 * (1 + Math.floor(uniform(market.traits) * 6)),
    receivedEpisodeId: null,
    signal: null,
    pendingTarget: null,
    reach: type === 'value' || type === 'trend' ? reach : 1,
    bias: (uniform(market.random) - 0.5) * C.INITIAL_BIAS_RANGE,
    jitter: uniform(market.random),
    style: uniform(market.random),
    view: 0,
    forecast: 0,
    anchor: market.price,
    filled: 0,
    lastTradeMs: C.INITIAL_LAST_TRADE_MS,
    lastAction: ''
  };
}

export function resizePopulation(market, targetCount) {
  if (!Number.isInteger(targetCount) || targetCount < C.POPULATION_MIN || targetCount > C.POPULATION_MAX) {
    throw new Error(`Population must be ${C.POPULATION_MIN}–${C.POPULATION_MAX}.`);
  }
  while (market.agents.length < targetCount) {
    const type = pickTypeByDraw(uniform(market.traits), market.ratios);
    const agent = createAgent(market, market.agents.length, type);
    market.agents.push(agent);
    market.initialCash += agent.cash;
    market.initialShares += agent.shares;
  }
  while (market.agents.length > targetCount) {
    const victimIdx = Math.floor(uniform(market.traits) * market.agents.length);
    const victim = market.agents[victimIdx];
    market.cancelAgent(victim.id);
    market.initialCash -= victim.cash;
    market.initialShares -= victim.shares;
    const last = market.agents.pop();
    if (victimIdx < market.agents.length) {
      last.id = victimIdx;
      market.agents[victimIdx] = last;
      market.exchange.reassignAgent(market.agents.length, victimIdx);
    }
  }
  syncPools(market);
  refreshMakers(market);
}

export function reassignRatios(market, ratios) {
  market.ratios = normalizeRatios(ratios);
  const n = market.agents.length;
  for (let i = 0; i < n; i++) {
    const agent = market.agents[i];
    const nextType = pickTypeByDraw(i / n, market.ratios);
    if (agent.type === nextType) continue;
    if (agent.type === 'maker') market.cancelAgent(agent.id);
    agent.type = nextType;
    agent.reach = nextType === 'value' || nextType === 'trend' ? (agent.reach < 1 ? agent.reach : uniform(market.traits)) : 1;
  }
  syncPools(market);
  refreshMakers(market);
}
