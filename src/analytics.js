export const HISTORY_MS = 6 * 60 * 60 * 1000;
export const BASE_MS = 10000;
export const CANDLE_SECONDS = [10, 30, 60, 300, 900, 3600];

export const TICK_SIZES = [1, 12, 144];
export const TICK_KEEP = 300;

export function createFlow() {
  return {
    total: 0,
    buys: 0,
    sells: 0,
    counts: {},
    byOrigin: {
      baseline: 0,
      informed: 0,
      maker: 0
    }
  };
}

export function recordExecution(market, fill) {
  const secondTimestampMs = Math.floor(fill.timeMs / BASE_MS) * BASE_MS;
  let lastCandle = market.candles.at(-1);

  if (!lastCandle || lastCandle.timeMs !== secondTimestampMs) {
    lastCandle = {
      timeMs: secondTimestampMs,
      open: fill.price,
      high: fill.price,
      low: fill.price,
      close: fill.price,
      volume: 0,
      trades: 0
    };
    market.candles.push(lastCandle);
    pruneCandles(market);
  }

  lastCandle.high = Math.max(lastCandle.high, fill.price);
  lastCandle.low = Math.min(lastCandle.low, fill.price);
  lastCandle.close = fill.price;
  lastCandle.volume += fill.qty;
  lastCandle.trades++;

  for (let i = 0; i < TICK_SIZES.length; i++) {
    const size = TICK_SIZES[i];
    const series = market.tickCandles[i];
    let tick = series.at(-1);
    if (!tick || tick.trades === size) {
      tick = { timeMs: Math.floor(fill.timeMs), open: fill.price, high: fill.price, low: fill.price, close: fill.price, volume: 0, trades: 0 };
      series.push(tick);
      if (series.length > TICK_KEEP) series.shift();
    }
    tick.high = Math.max(tick.high, fill.price);
    tick.low = Math.min(tick.low, fill.price);
    tick.close = fill.price;
    tick.volume += fill.qty;
    tick.trades++;
  }

  const signedSize = fill.side === 'buy' ? fill.qty : -fill.qty;
  const flow = market.flow;

  flow.counts[signedSize] = (flow.counts[signedSize] || 0) + 1;
  flow.total++;
  flow.byOrigin[fill.origin]++;

  if (fill.side === 'buy') {
    flow.buys++;
  } else {
    flow.sells++;
  }
}

export function pruneCandles(market) {
  const cutoffTimeMs = Math.floor(market.timeMs / BASE_MS) * BASE_MS - HISTORY_MS;
  while (market.candles.length > 0 && market.candles[0].timeMs < cutoffTimeMs) {
    market.candles.shift();
  }
}

export function candleSeries(market, windowSeconds = 1800, intervalSeconds = BASE_MS / 1000, endTimeMs = market.timeMs) {
  const intervalMs = intervalSeconds * 1000;
  const startTimeMs = Math.max(0, endTimeMs - windowSeconds * 1000);
  const buckets = [];

  for (const candle of market.candles) {
    const bucketTimeMs = Math.floor(candle.timeMs / intervalMs) * intervalMs;

    if (bucketTimeMs + intervalMs <= startTimeMs || bucketTimeMs > endTimeMs) {
      continue;
    }

    let lastBucket = buckets.at(-1);
    if (!lastBucket || lastBucket.timeMs !== bucketTimeMs) {
      lastBucket = { ...candle, timeMs: bucketTimeMs };
      buckets.push(lastBucket);
    } else {
      lastBucket.high = Math.max(lastBucket.high, candle.high);
      lastBucket.low = Math.min(lastBucket.low, candle.low);
      lastBucket.close = candle.close;
      lastBucket.volume += candle.volume;
      lastBucket.trades += candle.trades;
    }
  }

  return buckets;
}

export function autoInterval(durationMs, width) {
  const availableSlots = Math.max(1, Math.floor(width / 6));
  return CANDLE_SECONDS.find(seconds => durationMs / (seconds * 1000) <= availableSlots) ?? 3600;
}

export function flowSeries(flow) {
  return Object.entries(flow.counts)
    .map(([size, count]) => ({ size: Number(size), count }))
    .sort((a, b) => a.size - b.size);
}
