import { uniform } from './clock.js';
import { EPISODE_BINS, activeEpisode, burstLevel, informedAgents } from './information.js';
import { attemptCustomer } from './strategies.js';
import { MAX_SIZE, STRATEGY_INTERVAL_MS, weights } from './model.js';
import { countAttempt } from './diagnostics.js';

const cdfCache = new WeakMap();

function buildCdf(arr) {
  const n = arr.length;
  const cdf = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += arr[i];
    cdf[i] = total;
  }
  return { cdf, total };
}

function drawFromCdf(stream, cdf, total) {
  const target = uniform(stream) * total;
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

export function informedRates(model, timeMs, episode, baselineRate) {
  if (!episode || timeMs < episode.startMs || timeMs >= episode.releaseMs) {
    return null;
  }
  const rates = model.informed((timeMs - episode.startMs) / 1000, episode.durationSeconds, episode.params);
  if (rates && !(weights(rates) && rates.length <= MAX_SIZE)) {
    throw new Error(`Flow model "${model.id}" returned invalid informed rates.`);
  }
  return rates && rates.map(rate => rate * baselineRate);
}

export function poisson(stream, mean) {
  if (!Number.isFinite(mean) || mean < 0) {
    throw new Error('Poisson mean must be finite and nonnegative.');
  }
  if (mean > 100000) throw new Error('Attempt rate exceeds the sampling capacity (100,000 per interval).');
  let total = 0;
  for (let remaining = mean; remaining > 0; remaining -= 20) {
    const threshold = Math.exp(-Math.min(remaining, 20));
    let product = uniform(stream);
    while (product > threshold) {
      total++;
      product *= uniform(stream);
    }
  }
  return total;
}

export function sampleSize(stream, list) {
  if (Object.isFrozen(list)) {
    let entry = cdfCache.get(list);
    if (!entry) {
      entry = buildCdf(list);
      cdfCache.set(list, entry);
    }
    return drawFromCdf(stream, entry.cdf, entry.total);
  }
  const { cdf, total } = buildCdf(list);
  return drawFromCdf(stream, cdf, total);
}

export function expectedBaseline(market) {
  const baseline = market.diagnostics.baseline;
  return baseline.expected + (market.clock.rate * (market.timeMs - baseline.sinceMs)) / 1000;
}

export function placeCustomer(market) {
  const customers = market.customers;
  const agent = customers[Math.floor(uniform(market.random) * customers.length)];
  return agent ? attemptCustomer(market, agent, sampleSize(market.random, market.modelSample.noise)) : null;
}

export function placeInformed(market) {
  const episode = activeEpisode(market);
  const rawRates = episode && market.timeMs < episode.releaseMs ? market.modelSample.rates : null;
  if (!rawRates || !rawRates.length) {
    return;
  }

  let rawTotal = 0;
  for (let i = 0; i < rawRates.length; i++) rawTotal += rawRates[i];
  const mean = rawTotal * market.clock.rate * STRATEGY_INTERVAL_MS / 1000;
  market.diagnostics.informed.expected += mean;

  const progress = (market.timeMs - episode.startMs) / (episode.durationSeconds * 1000);
  const count = poisson(market.informed, mean * burstLevel(episode, progress * episode.durationSeconds));
  if (episode.arrivals) episode.arrivals[Math.min(EPISODE_BINS - 1, Math.floor(progress * EPISODE_BINS))] += count;
  if (!count) return;

  const { cdf, total } = buildCdf(rawRates);
  const receivers = informedAgents(market);
  const side = market.model.direction === 'shock' ? (episode.impact > 0 ? 'buy' : 'sell') : null;

  for (let i = 0; i < count; i++) {
    const size = drawFromCdf(market.informed, cdf, total);
    if (side) countAttempt(market, 'informed', size, side);
    if (!receivers.length) {
      if (!side) countAttempt(market, 'informed', size, null);
      market.diagnostics.informed.unrouted++;
      continue;
    }
    const agent = receivers[Math.floor(uniform(market.informedRouting) * receivers.length)];
    attemptCustomer(market, agent, size, side, 'informed', episode.id);
  }
}
