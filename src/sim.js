import { gammaMultiplier, uniform, waitingMs } from './clock.js';
import { Exchange } from './exchange.js';
import { activeEpisode, diffuse, startEpisode, releasePublic, knowledge } from './information.js';
import { expectedBaseline, placeCustomer, placeInformed } from './flow.js';
import { createDiagnostics } from './diagnostics.js';
import { NEUTRAL, createModel, limits, DEFAULTS, DEFAULT_RATIOS, ACTIVITY_LIMITS, PRIVATE_WINDOW, STRATEGY_INTERVAL_MS, sampleModel, ENGINE_CONFIG as C } from './model.js';
import { TYPES, activeMaker, refreshMakers, updateStrategies } from './strategies.js';
import { createFlow, pruneCandles, TICK_SIZES } from './analytics.js';
import { strategyEdges } from './metrics.js';
import { createAgent, normalizeRatios, pickTypeByDraw, reassignRatios, resizePopulation, syncPools } from './agents.js';

const EDGE_SAMPLE_MS = 10000;
const EDGE_HISTORY_KEEP = 2160;

export { TYPES };
export { LIMITS, limits } from './model.js';

export class Market {
  constructor({
    model = NEUTRAL,
    seed = DEFAULTS.seed,
    population = DEFAULTS.population,
    ratios = DEFAULT_RATIOS,
    liquidity = DEFAULTS.liquidity,
    trend = DEFAULTS.trend,
    uncertainty = DEFAULTS.uncertainty,
    activity = DEFAULTS.activity,
    privateWindowSeconds = DEFAULTS.privateWindowSeconds,
    feeBps = C.TAKER_FEE_BPS,
    ...params
  } = {}) {
    model = createModel(model);
    if (!Number.isInteger(population) || population < C.POPULATION_MIN || population > C.POPULATION_MAX) {
      throw new Error(`Population must be ${C.POPULATION_MIN}–${C.POPULATION_MAX}.`);
    }
    if (!Number.isInteger(seed) || seed < 0 || seed > C.SEED_MAX) {
      throw new Error(`Seed must be a whole number from 0 to ${C.SEED_MAX}.`);
    }

    this.initialSeed = seed;
    this.modelId = model.id;
    this.timeMs = 0;
    this.nextStrategyMs = STRATEGY_INTERVAL_MS;
    this.random = { seed };
    this.signals = { seed: (seed ^ 0x836f21b5) >>> 0 };
    this.traits = { seed: (seed ^ 0x591c3e47) >>> 0 };
    this.volatility = 0;
    this.flowToxicity = 0;
    this.sentiment = 0;
    this.feeBps = Number.isFinite(feeBps) && feeBps >= 0 ? feeBps : C.TAKER_FEE_BPS;
    this.lastVolatilityMid = C.INITIAL_PRICE;
    this.informed = { seed: (seed ^ C.INFORMED_SEED_SALT) >>> 0 };
    this.informedRouting = { seed: (seed ^ C.ROUTING_SEED_SALT) >>> 0 };
    this.clock = { seed: (seed ^ C.CLOCK_SEED_SALT) >>> 0, rate: DEFAULTS.activity, multiplier: 1, excitation: 0, nextMs: 0 };
    this.clock.multiplier = gammaMultiplier(this.clock, 3);
    this.settings = {};
    this.price = C.INITIAL_PRICE;
    this.value = C.INITIAL_PRICE;
    this.orders = [];
    this.trades = [];
    this.events = [];
    this.episodeId = null;
    this.priceHistory = [{ timeMs: 0, price: this.price, value: this.value }];
    this.edgeHistory = [];
    this.quoteHistory = [{ timeMs: 0, mid: this.price }];
    this.candles = [];
    this.tickCandles = TICK_SIZES.map(() => []);
    this.auto = { seed: (seed ^ C.AUTO_SEED_SALT) >>> 0, enabled: false, ratePerHour: C.AUTO_RATE_PER_HOUR, nextMs: 0 };
    this.flow = createFlow();
    this.diagnostics = createDiagnostics();
    this.nextOrder = 1;
    this.tradeCount = 0;
    this.volume = 0;
    this.signalSequence = 0;

    this.ratios = normalizeRatios(ratios);
    this.agents = Array.from({ length: population }, (_, id) => {
      const type = pickTypeByDraw(id / population, this.ratios);
      return createAgent(this, id, type);
    });
    syncPools(this);

    this.initialCash = this.agents.reduce((total, agent) => total + agent.cash, 0);
    this.initialShares = this.agents.reduce((total, agent) => total + agent.shares, 0);

    this.attach(model);
    this.configure({
      liquidity,
      trend,
      uncertainty,
      privateWindowSeconds,
      ...Object.fromEntries(model.params.map(([key, , , , , , value]) => [key, params[key] ?? value]))
    });
    this.setArrivalRate(activity);
    sampleModel(this);
    refreshMakers(this);
  }

  attach(model) {
    Object.defineProperty(this, 'model', { value: model, configurable: true });
    Object.defineProperty(this, 'exchange', { value: new Exchange(this), configurable: true });
  }

  episodeParams() {
    return Object.fromEntries(this.model.params.map(([key]) => [key, this.settings[key]]));
  }

  book() {
    return this.exchange.book();
  }

  bestBid() {
    return this.exchange.bestBid();
  }

  bestAsk() {
    return this.exchange.bestAsk();
  }

  mid() {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid !== null && ask !== null ? (bid + ask) / 2 : this.price;
  }

  submit(...args) {
    return this.exchange.submit(...args);
  }

  cancel(order) {
    this.exchange.cancel(order);
  }

  cancelAgent(id) {
    this.exchange.cancelAgent(id);
  }

  configure(patch) {
    const settingLimits = limits(this.model);
    for (const [key, low, high] of settingLimits) {
      if (key in patch && !(Number.isFinite(patch[key]) && patch[key] >= low && patch[key] <= high)) {
        throw new Error(`${key} must be ${low}–${high}.`);
      }
    }
    for (const [key] of settingLimits) {
      if (key in patch) this.settings[key] = patch[key];
    }
    for (const agent of this.makers) {
      if (!activeMaker(this, agent)) {
        this.cancelAgent(agent.id);
      }
    }
    refreshMakers(this);
  }

  setArrivalRate(rate) {
    const [low, high] = ACTIVITY_LIMITS;
    if (!Number.isFinite(rate) || rate < low || rate > high) {
      throw new Error(`Activity must be ${low}–${high} arrivals per simulated second.`);
    }
    this.diagnostics.baseline.expected = expectedBaseline(this);
    this.diagnostics.baseline.sinceMs = this.timeMs;
    this.clock.rate = rate;
    this.clock.nextMs = this.timeMs + waitingMs(this.clock, this.clock.multiplier ?? 1);
  }

  advance(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > C.MAX_ADVANCE_MS) {
      throw new Error('Invalid time advance.');
    }

    const targetTimeMs = this.timeMs + milliseconds;
    for (;;) {
      const releaseMs = activeEpisode(this)?.releaseMs ?? Infinity;
      const next = Math.min(releaseMs, this.nextStrategyMs, this.clock.nextMs);
      if (next > targetTimeMs) break;
      this.timeMs = next;

      if (releaseMs === next) {
        releasePublic(this);
      } else if (this.nextStrategyMs === next) {
        for (let i = this.orders.length - 1; i >= 0; i--) {
          if (this.orders[i].expiresAtMs <= this.timeMs) this.cancel(this.orders[i]);
        }
        if (this.timeMs % 5000 === 0) {
          this.clock.multiplier = gammaMultiplier(this.clock, 3);
        }
        this.clock.excitation = (this.clock.excitation ?? 0) * Math.exp(-0.25 / 3);
        this.flowToxicity = (this.flowToxicity ?? 0) * Math.exp(-0.25 / 5);
        this.sentiment = Math.max(-0.22, Math.min(0.22, (this.sentiment ?? 0) * Math.exp(-0.25 / 30) + (uniform(this.random) - 0.5) * 0.08));
        this.maybeRandomEpisode();
        sampleModel(this, activeEpisode(this));
        this.nextStrategyMs += STRATEGY_INTERVAL_MS;
        const midpoint = this.mid();
        const absoluteReturn = Math.abs(midpoint / this.lastVolatilityMid - 1) * 10000;
        this.volatility += (1 - Math.exp(-0.25 / 10)) * (absoluteReturn - this.volatility);
        this.lastVolatilityMid = midpoint;
        diffuse(this);
        updateStrategies(this);
        placeInformed(this);
        if (this.timeMs % C.PRICE_SAMPLE_MS === 0) this.recordPrice();
        if (this.timeMs % EDGE_SAMPLE_MS === 0) this.recordEdge();
      } else {
        this.clock.nextMs += waitingMs(this.clock, (this.clock.multiplier ?? 1) * (1 + (this.clock.excitation ?? 0)));
        placeCustomer(this);
      }
    }

    this.timeMs = targetTimeMs;
    pruneCandles(this);
  }

  setRandomEpisodes(enabled, ratePerHour = this.auto.ratePerHour) {
    this.auto.enabled = Boolean(enabled);
    this.auto.ratePerHour = ratePerHour;
    if (this.auto.enabled) {
      this.auto.nextMs = this.timeMs + this.randomGapMs();
    }
  }

  randomGapMs() {
    return -Math.log1p(-uniform(this.auto)) * C.HOUR_MS / this.auto.ratePerHour;
  }

  maybeRandomEpisode() {
    const { auto } = this;
    const sigma = 0.45;
    while (auto.enabled && this.timeMs >= auto.nextMs) {
      auto.nextMs += this.randomGapMs();
      const sign = uniform(auto) < 0.5 ? -1 : 1;
      const rawSize = -Math.log1p(-uniform(auto)) * C.NEWS_IMPACT;
      const size = Math.min(C.MAX_NEWS_IMPACT, Math.max(C.NEWS_IMPACT_STEP, Math.round(rawSize / C.NEWS_IMPACT_STEP) * C.NEWS_IMPACT_STEP));
      const u1 = Math.max(1e-12, uniform(auto));
      const u2 = uniform(auto);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const rawDuration = this.settings.privateWindowSeconds * Math.exp(sigma * z - 0.5 * sigma * sigma);
      const duration = Math.max(PRIVATE_WINDOW[3], Math.min(PRIVATE_WINDOW[4], Math.round(rawDuration / PRIVATE_WINDOW[5]) * PRIVATE_WINDOW[5]));
      if (this.episodeId === null) {
        startEpisode(this, sign * size, duration);
      }
    }
  }

  recordPrice() {
    const secondMs = Math.floor(this.timeMs / C.PRICE_SAMPLE_MS) * C.PRICE_SAMPLE_MS;
    const point = { timeMs: secondMs, price: this.price, value: this.value };
    if (this.priceHistory.at(-1)?.timeMs === secondMs) {
      this.priceHistory[this.priceHistory.length - 1] = point;
    } else {
      this.priceHistory.push(point);
    }
    if (this.priceHistory.length > C.PRICE_HISTORY_KEEP) {
      this.priceHistory.shift();
    }
  }

  recordEdge() {
    this.edgeHistory.push({ timeMs: this.timeMs, edge: strategyEdges(this) });
    if (this.edgeHistory.length > EDGE_HISTORY_KEEP) this.edgeHistory.shift();
  }

  news(impact = C.NEWS_IMPACT, durationSeconds = this.settings.privateWindowSeconds) {
    if (
      !Number.isFinite(impact) ||
      Math.abs(impact) > C.MAX_NEWS_IMPACT ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds < PRIVATE_WINDOW[3] ||
      durationSeconds > PRIVATE_WINDOW[4]
    ) {
      throw new Error(`Choose an impact within ±${C.MAX_NEWS_IMPACT}% and a private window of ${PRIVATE_WINDOW[3]}–${PRIVATE_WINDOW[4]} seconds.`);
    }
    return impact === 0 ? null : startEpisode(this, impact, durationSeconds);
  }

  newsProgress(event, type) {
    return knowledge(this, event, type);
  }

  setPopulation(targetCount) {
    resizePopulation(this, targetCount);
  }

  setRatios(ratios) {
    reassignRatios(this, ratios);
  }

  expectedAttempts() {
    return { baseline: expectedBaseline(this), informed: this.diagnostics.informed.expected };
  }

  assertAccounting() {
    const reservedCash = Array(this.agents.length).fill(0);
    const reservedShares = Array(this.agents.length).fill(0);
    for (const order of this.orders) {
      if (order.side === 'buy') reservedCash[order.agent] += order.price * order.qty;
      else reservedShares[order.agent] += order.qty;
    }

    for (const agent of this.agents) {
      if (
        agent.cash < agent.reservedCash ||
        agent.shares < agent.reservedShares ||
        agent.reservedCash !== reservedCash[agent.id] ||
        agent.reservedShares !== reservedShares[agent.id] ||
        agent.reservedCash < 0 ||
        agent.reservedShares < 0
      ) {
        throw new Error('Invalid resource reservations.');
      }
    }

    const cash = this.agents.reduce((sum, agent) => sum + agent.cash, 0);
    const shares = this.agents.reduce((sum, agent) => sum + agent.shares, 0);
    if (cash !== this.initialCash || shares !== this.initialShares) {
      throw new Error('Resources are not conserved.');
    }
    return true;
  }
}
