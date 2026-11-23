export const MAX_SIZE = 500;

export const CONDITIONS = [
  ['liquidity', 'Liquidity', 'How many market makers quote, and how deep. More means smoother trading', 0, 100, 1, 85],
  ['trend', 'Trend following', 'How strongly trend followers chase price movement', 0, 100, 1, 35],
  ['uncertainty', 'Disagreement', 'How widely traders disagree about the value of the asset', 0, 100, 1, 25],
  ['activity', 'Activity', 'Everyday trade attempts per simulated second, buys and sells combined', 1, 200, 1, 20]
];
export const PRIVATE_WINDOW = ['privateWindowSeconds', 'Head start', 'Seconds insiders know before everyone else, until public release', 30, 3600, 30, 300];
export const CONDITION_KEYS = CONDITIONS.map(([key]) => key);
export const DEFAULT_CONDITIONS = Object.fromEntries(CONDITIONS.map(([key, , , , , , value]) => [key, value]));
export const DEFAULT_RATIOS = Object.freeze({ maker: 15, value: 35, trend: 25, random: 25 });
export const RATIO_KEYS = Object.freeze(['maker', 'value', 'trend', 'random']);
export const DEFAULTS = { seed: 24816, population: 250, ratios: DEFAULT_RATIOS, ...DEFAULT_CONDITIONS, privateWindowSeconds: PRIVATE_WINDOW[6] };
export const ACTIVITY_LIMITS = CONDITIONS.find(([key]) => key === 'activity').slice(3, 5);
export const LIMITS = [...CONDITIONS.filter(([key]) => key !== 'activity'), PRIVATE_WINDOW]
  .map(([key, , , low, high]) => [key, low, high]);

export function limits(model) {
  return [...LIMITS, ...model.params.map(([key, , , low, high]) => [key, low, high])];
}

export const STRATEGY_INTERVAL_MS = 250;

export const ENGINE_CONFIG = Object.freeze({
  POPULATION_MIN: 8,
  POPULATION_MAX: 5000,
  SEED_MAX: 4294967295,
  INITIAL_PRICE: 10000,
  INITIAL_SHARES: 800,
  INITIAL_SHARES_RANGE: 800,
  INITIAL_CASH_UNITS: 1000,
  INITIAL_CASH_RANGE: 800,
  INITIAL_BIAS_RANGE: 40,
  INITIAL_LAST_TRADE_MS: -10000,
  TAKER_FEE_BPS: 2,
  PRICE_SAMPLE_MS: 1000,
  PRICE_HISTORY_KEEP: 1801,
  MAX_ADVANCE_MS: 3600000,
  HOUR_MS: 3600000,
  AUTO_RATE_PER_HOUR: 4,
  NEWS_IMPACT: 2,
  MAX_NEWS_IMPACT: 50,
  NEWS_IMPACT_STEP: 0.1,
  INFORMED_SEED_SALT: 0x6c8e9cf5,
  ROUTING_SEED_SALT: 0x9e3779b9,
  CLOCK_SEED_SALT: 0xa511e9b3,
  AUTO_SEED_SALT: 0x2545f491
});

const noise = Object.freeze(Array.from({ length: MAX_SIZE }, (_, i) => (i + 1) ** -1.5));
const noiseTotal = noise.reduce((sum, weight) => sum + weight, 0);
const informedSizes = Object.freeze(noise.map(weight => weight / noiseTotal));

const SPREAD_STEEPNESS = 10;
const sigmoid = x => 1 / (1 + Math.exp(-x));
const SIGMOID_LOW = sigmoid(-SPREAD_STEEPNESS / 2);

export const logisticShare = (t, W) =>
  Math.min(1, Math.max(0, (sigmoid(SPREAD_STEEPNESS * (t / W - 0.5)) - SIGMOID_LOW) / (1 - 2 * SIGMOID_LOW)));

export const NEUTRAL = {
  id: 'public-demo-v1',
  name: 'Public demo',
  direction: 'strategy',
  stateDependent: false,
  params: [],
  noise,
  penetration: logisticShare,
  informed: (seconds, windowSeconds) => {
    const share = NEUTRAL.penetration(seconds, windowSeconds);
    return informedSizes.map(weight => weight * share);
  },
  evaluate: ({ t, W }) => {
    const share = logisticShare(t, W);
    return { noise, rates: share > 0 ? informedSizes.map(weight => weight * share) : null, share };
  }
};

export const weights = (v, length = v?.length) =>
  Array.isArray(v) && v.length === length && v.every(x => Number.isFinite(x) && x >= 0);

export function createModel(spec = NEUTRAL) {
  if (!spec || spec === NEUTRAL) return NEUTRAL;
  if (typeof spec.penetration === 'function' && typeof spec.informed === 'function' && weights(spec.noise)) {
    const params = Array.isArray(spec.params) ? spec.params : [];
    const evaluate = spec.evaluate ?? (({ t, W, ...rest }) => {
      const share = Math.min(1, Math.max(0, spec.penetration(t, W)));
      const rates = spec.informed(t, W, rest);
      return { noise: [...spec.noise], rates: rates && [...rates], share };
    });
    return Object.freeze({
      ...spec,
      params: Object.freeze(params.map(p => Object.freeze([...p]))),
      noise: Object.freeze([...spec.noise]),
      direction: spec.direction ?? 'shock',
      stateDependent: spec.stateDependent ?? false,
      evaluate
    });
  }
  throw new Error('Only the built-in flow model is supported.');
}

export function modelContext(market, episode = null) {
  const book = market.book();
  const activeNoise = market.modelSample?.noise ?? market.model.noise;
  return Object.freeze({ ...market.episodeParams(), ...(episode?.params ?? {}), q: 1,
    time: market.timeMs / 1000, t: episode ? (market.timeMs - episode.startMs) / 1000 : 0,
    W: episode?.durationSeconds ?? market.settings.privateWindowSeconds, impact: episode?.impact ?? 0,
    price: market.price / 100, mid: market.mid() / 100,
    spread: book.bid === null || book.ask === null ? 0 : book.ask - book.bid,
    buyDepth: book.buyDepth, sellDepth: book.sellDepth,
    noise: activeNoise[0], noiseShare: activeNoise[0] / activeNoise.reduce((s, w) => s + w, 0) });
}

export function sampleModel(market, episode = null) {
  const context = market.model.stateDependent
    ? modelContext(market, episode)
    : Object.freeze({
      ...market.episodeParams(),
      ...(episode?.params ?? {}),
      t: episode ? (market.timeMs - episode.startMs) / 1000 : 0,
      W: episode?.durationSeconds ?? market.settings.privateWindowSeconds,
      impact: episode?.impact ?? 0
    });
  const result = market.model.evaluate(context);
  if (episode) result.share = episode.share = Math.max(episode.share ?? 0, result.share);
  market.modelSample = { ...result, context, atMs: market.timeMs };
  return result;
}
