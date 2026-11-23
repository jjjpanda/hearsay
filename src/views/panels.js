import { modelContext } from '../model.js';
import { elapsed, money } from '../clock.js';
import { flowSeries } from '../analytics.js';
import { episodeDiscovery, counterpartyMatrix, strategyEdges } from '../metrics.js';
import { EPISODE_BINS, activeEpisode } from '../information.js';
import { CANVAS_FONT, LANE_LABELS, drawDot, drawLine, drawPath, drawText, prepareSurface } from './canvas.js';
import { drawAcrylicDab, drawInkBar, drawInkBleed, drawInkCurve, drawWatercolorBloom, newsColor } from './ink.js';

const BLOOM_MS = 1600;

function expectedInformed(view, market, maxSize) {
  const episode = activeEpisode(market);
  const expected = market.diagnostics.informed.expected;
  if (!episode || !(expected > 0)) return null;
  const { rates } = view.episodeCurve(market.model, episode.durationSeconds, episode.params, 80, modelContext(market, episode)).peak;
  const total = rates?.reduce((sum, rate) => sum + rate, 0);
  if (!(total > 0)) return null;
  const side = Math.sign(episode.impact) || 1;
  return rates.slice(0, maxSize).map((rate, i) => ({ size: side * (i + 1), count: (expected * rate) / total }));
}

function freshness(view, market, series) {
  const now = view.ink.clockMs;
  if (view.flowInk?.flow !== market.flow) view.flowInk = { flow: market.flow, seen: new Map(), born: new Map(), clockMs: null };
  const ink = view.flowInk;
  const ticking = ink.clockMs !== null && now > ink.clockMs && !view.reducedMotion;
  for (const { size, count } of series) {
    if (ticking && count > (ink.seen.get(size) ?? 0)) ink.born.set(size, now);
    ink.seen.set(size, count);
  }
  ink.clockMs = now;
  return size => (ink.born.has(size) ? Math.max(0, 1 - (now - ink.born.get(size)) / BLOOM_MS) : 0);
}

export function drawFlow(view, market) {
  const { INK, GRID, BAR, UP, DOWN } = view.palette;
  const { ctx, w: width, h: height } = prepareSurface(view.flow, view.palette);
  if (width < 10 || height < 10) {
    return;
  }

  const left = 40;
  const right = width - 20;
  const top = 26;
  const bottom = height - 22;

  const series = flowSeries(market.flow);
  const maxSize = Math.max(100, ...series.map(point => Math.abs(point.size)));
  const theory = expectedInformed(view, market, maxSize);
  const maxCount = Math.ceil(Math.max(1, ...series.map(point => point.count), ...(theory ?? []).map(point => point.count)));

  const signedLog = size => Math.sign(size) * Math.log1p(Math.abs(size));
  const sizeToX = size => left + ((signedLog(size) / Math.log1p(maxSize) + 1) / 2) * (right - left);
  const scale = count => (view.logCounts ? Math.log1p(count) / Math.log1p(maxCount) : count / maxCount);
  const countToY = count => bottom - scale(count) * (bottom - top);

  const mid = view.logCounts ? Math.round(Math.expm1(Math.log1p(maxCount) / 2)) : Math.ceil(maxCount / 2);
  for (const count of new Set([0, mid, maxCount])) {
    const py = countToY(count);
    drawLine(ctx, left, py, right, py, GRID, [2, 4]);
    drawText(ctx, count.toLocaleString('en-US'), left - 6, py + 3, { align: 'right' });
  }

  const zeroX = sizeToX(0);
  drawLine(ctx, zeroX, top, zeroX, bottom, INK + '55', [3, 3]);

  const isLight = view.theme === 'light';
  const wetOf = freshness(view, market, series);
  const barWidth = Math.max(1.5, Math.min(14, (right - left) / (4 * Math.log1p(maxSize) * 8)));
  let hoveredBar = null;
  let bestDist = 8;
  const blooms = [];
  for (const point of series) {
    const barX = sizeToX(point.size);
    const barY = countToY(point.count);
    if (view.flowPointer) {
      const d = Math.abs(barX - view.flowPointer.x);
      if (d < bestDist) {
        bestDist = d;
        hoveredBar = { point, x: barX, y: barY };
      }
    }
    const barColor = point.size > 0 ? UP : point.size < 0 ? DOWN : BAR;
    const wet = wetOf(point.size);
    drawInkBar(ctx, barX, barY, barWidth, bottom, barColor, isLight, wet);
    if (wet > 0.03) blooms.push([barX, barY, wet, point.size, barColor]);
  }
  for (const [x, y, wet, size, color] of blooms) {
    const radius = 3 + barWidth * (1 + wet);
    if (isLight) drawWatercolorBloom(ctx, x, y, radius, wet, size, color, Math.sign(size));
    else drawAcrylicDab(ctx, x, y, radius, wet, color);
  }

  if (theory) {
    drawInkCurve(ctx, theory.map(point => [sizeToX(point.size), countToY(point.count)]), bottom, INK, isLight, [4, 3], 0.6);
  }

  if (hoveredBar) {
    ctx.fillStyle = INK;
    ctx.fillRect(hoveredBar.x - barWidth / 2, hoveredBar.y, barWidth, bottom - hoveredBar.y);
    const pct = market.flow.total > 0 ? ((hoveredBar.point.count / market.flow.total) * 100).toFixed(1) : '0.0';
    const s = hoveredBar.point.size;
    drawText(
      ctx,
      `${s > 0 ? '+' : ''}${s} shares · ${hoveredBar.point.count.toLocaleString('en-US')} fills (${pct}%)`,
      left + 4,
      top - 2,
      { color: INK }
    );
  }

  for (const size of [-maxSize, -10, 0, 10, maxSize]) {
    drawText(ctx, `${size > 0 ? '+' : ''}${size}`, sizeToX(size), height - 7, {
      align: 'center'
    });
  }

  if (view.flowLabelSource !== market.flow || view.flowLabelTotal !== market.flow.total) {
    view.flow.setAttribute?.(
      'aria-label',
      `Signed execution-size histogram. Execution count since reset: ${market.flow.total}. ${series
        .map(point => `${point.size > 0 ? '+' : ''}${point.size} units: ${point.count}`)
        .join('; ')}`
    );
    view.flowLabelSource = market.flow;
    view.flowLabelTotal = market.flow.total;
  }
}

function observedRate(market, event, peakRate) {
  if (!event?.arrivals || !(peakRate > 0)) return null;
  const binSeconds = event.durationSeconds / EPISODE_BINS;
  const bins = Math.min(EPISODE_BINS, Math.ceil((market.timeMs - event.startMs) / 1000 / binSeconds));
  const perBinPeak = peakRate * market.clock.rate * binSeconds;
  return Array.from({ length: Math.max(0, bins) }, (_, i) => {
    let sum = 0, weight = 0;
    for (let j = Math.max(0, i - 6); j <= Math.min(bins - 1, i + 6); j++) {
      const w = Math.exp(-((j - i) ** 2) / 8);
      sum += w * event.arrivals[j];
      weight += w;
    }
    return { seconds: (i + 0.5) * binSeconds, rate: sum / weight / perBinPeak };
  });
}

export function drawEpisode(view, market) {
  const { INK, MUTED, GRID, ACCENT, UP, DOWN, NEWS } = view.palette;
  const { ctx, w: width, h: height } = prepareSurface(view.episode, view.palette);
  if (width < 10 || height < 10) return;

  const isLight = view.theme === 'light';
  const event =
    (view.selectedEventId !== null && market.events.find(e => e.id === view.selectedEventId)) ||
    market.events.at(-1);
  const span = event ? event.durationSeconds : market.settings.privateWindowSeconds;
  let discovery = null;
  if (event) {
    const cacheKey = `${event.id}:${event.releaseMs}:${market.timeMs}:${market.price}:${market.priceHistory.length}`;
    if (view._episodeDiscCache?.market === market && view._episodeDiscCache.key === cacheKey) {
      discovery = view._episodeDiscCache.value;
    } else {
      discovery = episodeDiscovery(market, event);
      view._episodeDiscCache = { market, key: cacheKey, value: discovery };
    }
  }
  const trajectory = discovery?.trajectory ?? [];
  const rawLow = Math.min(0, ...trajectory.map(p => p.ratio));
  const rawHigh = Math.max(1, ...trajectory.map(p => p.ratio));
  const rawSpan = Math.max(1, rawHigh - rawLow);
  const step = [0.5, 1, 2, 5, 10, 25, 50].find(s => rawSpan / s <= 6) ?? Math.pow(10, Math.floor(Math.log10(rawSpan)));
  const low = Math.floor(rawLow / step) * step;
  const high = Math.ceil(rawHigh / step) * step;
  const levels = [...new Set([0, 1, low, high])];
  const pct = level => `${Math.round(level * 100)}%`;

  ctx.font = `400 10px ${CANVAS_FONT}`;
  const maxLabelW = Math.max(...levels.map(l => ctx.measureText?.(pct(l))?.width ?? 28));
  const left = 38;
  const right = width - Math.max(30, Math.min(60, Math.ceil(maxLabelW) + 10));
  const top = 22;
  const bottom = height - 20;
  const toX = seconds => left + (seconds / span) * (right - left);
  const toY = value => bottom - value * (bottom - top);
  const responseY = ratio => bottom - ((ratio - low) / (high - low)) * (bottom - top);
  const params = event?.params ?? market.episodeParams();
  const { samples, peak } = view.episodeCurve(market.model, span, params, 80, modelContext(market, event));
  const intensity = rate => (peak.rate > 0 ? rate / peak.rate : 0);

  drawText(ctx, 'I(t) · λ(t)', left, 12, { color: MUTED, weight: 500, family: 'sans' });
  drawText(ctx, 'D(t)', width - 4, 12, { color: UP, align: 'right', weight: 500, family: 'sans' });
  for (const level of [0, 0.5, 1]) {
    drawLine(ctx, left, toY(level), right, toY(level), GRID, level === 0.5 ? [2, 4] : []);
    drawText(ctx, pct(level), left - 5, toY(level) + 3, { align: 'right' });
  }
  const drawnLabelYs = [];
  for (const level of levels) {
    const ly = responseY(level);
    drawLine(ctx, right, ly, right + 4, ly, UP);
    if (level === 0 && low < 0) drawLine(ctx, left, ly, right, ly, UP + '55', [2, 4]);
    if (drawnLabelYs.every(y => Math.abs(y - ly) >= 13)) {
      drawText(ctx, pct(level), right + 6, ly + 3, { color: UP });
      drawnLabelYs.push(ly);
    }
  }
  drawLine(ctx, right, top, right, bottom, INK + '66', [4, 3]);

  const observed = observedRate(market, event, peak.rate);
  const rateScale = Math.max(1, ...(observed ?? []).map(p => p.rate));
  drawInkCurve(ctx, samples.map(p => [toX(p.seconds), toY(p.share)]), bottom, NEWS, isLight, [], 0.5);
  drawInkCurve(ctx, samples.map(p => [toX(p.seconds), toY(intensity(p.rate) / rateScale)]), bottom, ACCENT, isLight, [5, 4], 0);
  if (observed?.length > 1) {
    drawInkCurve(ctx, observed.map(p => [toX(p.seconds), toY(p.rate / rateScale)]), bottom, ACCENT, isLight, [], 0.35);
  }

  const gap = event && discovery && Math.abs(discovery.targetGap) >= 1;
  if (gap && trajectory.length >= 2) {
    const pts = trajectory.map(p => [toX(Math.min(span, p.seconds)), responseY(p.ratio)]);
    const yZero = responseY(0);
    const fillWash = (clipTop, clipBottom, color) => {
      if (clipBottom <= clipTop) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, clipTop, right - left, clipBottom - clipTop);
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], yZero);
      for (const [px, py] of pts) ctx.lineTo(px, py);
      ctx.lineTo(pts.at(-1)[0], yZero);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = isLight ? 0.14 : 0.18;
      ctx.fill();
      ctx.restore();
    };
    fillWash(top, yZero, UP);
    fillWash(yZero, bottom, DOWN);
    drawInkCurve(ctx, pts, yZero, UP, isLight, [], 0);
    const last = pts.at(-1);
    drawDot(ctx, last[0], last[1], UP);
  } else if (gap && trajectory.length === 1) {
    drawDot(ctx, toX(Math.min(span, trajectory[0].seconds)), responseY(trajectory[0].ratio), UP);
  }
  drawText(ctx, '0s', left, height - 5, { align: 'left' });
  drawText(ctx, `${span}s`, right, height - 5, { align: 'right' });

  if (event && market.episodeId === event.id) {
    const seconds = Math.min(span, Math.max(0, (market.timeMs - event.startMs) / 1000));
    const rate = market.modelSample.rates?.reduce((sum, r) => sum + r, 0) ?? 0;
    drawLine(ctx, toX(seconds), top, toX(seconds), bottom, INK + 'aa');
    drawDot(ctx, toX(seconds), toY(event.share), NEWS);
    drawDot(ctx, toX(seconds), toY(intensity(rate)), ACCENT);
  }
}

const DEPTH_LEVELS = 12;
const SCALE_EASE = 0.08;

const easeScale = (prev, target) => prev
  ? Object.fromEntries(Object.entries(target).map(([k, v]) => [k, Math.max(v, prev[k] + (v - prev[k]) * SCALE_EASE)]))
  : target;
const BOOK_BLOOM_MS = 1100;
const BOOK_WICK_MS = 900;
const RATE_WINDOW_MS = 5000;

const inkWet = (clock, bornMs, life) => bornMs === undefined ? 0 : Math.max(0, 1 - (clock - bornMs) / life);
export const levelInk = (ink, level) => ({
  wet: inkWet(ink.clock, level?.bornMs, BOOK_BLOOM_MS),
  cut: inkWet(ink.clock, level?.cutMs, BOOK_WICK_MS)
});

export function trackBookInk(view, market, book = market.book()) {
  const clock = view.ink.clockMs;
  let state = view.bookInk;
  if (!state || state.market !== market || market.timeMs < state.timeMs) {
    state = view.bookInk = { market, book: null, timeMs: 0, clock, levels: new Map(), wicks: [], drops: [], tradeId: market.trades.at(-1)?.id ?? -1 };
  }
  const seeded = state.book !== null && clock > state.clock;
  state.clock = clock;
  state.wicks = state.wicks.filter(w => clock - w.bornMs < BOOK_WICK_MS);
  state.drops = state.drops.filter(d => clock - d.bornMs < BOOK_BLOOM_MS);
  if (state.book === book) return state;
  const levels = new Map();
  for (const [side, list] of [['buy', book.buyLevels], ['sell', book.sellLevels]]) {
    let cum = 0;
    for (const { price, qty } of list.slice(0, DEPTH_LEVELS)) {
      cum += qty;
      const prev = state.levels.get(price);
      const delta = qty - (prev?.side === side ? prev.qty : 0);
      const fresh = seeded && delta > 0;
      levels.set(price, { price, side, qty, cum, add: fresh ? delta : prev?.add ?? 0, bornMs: fresh ? clock : prev?.bornMs, cutMs: seeded && delta < 0 ? clock : prev?.cutMs });
      if (seeded && delta < 0) state.wicks.push({ price, side, from: prev.cum, to: prev.cum + delta, bornMs: clock });
    }
  }
  if (seeded) {
    for (const [price, prev] of state.levels) {
      if (!levels.has(price)) state.wicks.push({ price, side: prev.side, from: prev.cum, to: prev.cum - prev.qty, bornMs: clock });
    }
    for (let i = market.trades.length - 1; i >= 0 && market.trades[i].id > state.tradeId && state.drops.length < 64; i--) {
      const { price, qty, side } = market.trades[i];
      state.drops.push({ price, qty, side, bornMs: clock });
    }
  }
  state.wicks = state.wicks.slice(-24);
  state.drops = state.drops.slice(-48);
  state.tradeId = market.trades.at(-1)?.id ?? state.tradeId;
  state.levels = levels;
  state.book = book;
  state.timeMs = market.timeMs;
  return state;
}

function tradeRate(market) {
  const since = market.timeMs - RATE_WINDOW_MS;
  let count = 0;
  for (let i = market.trades.length - 1; i >= 0 && market.trades[i].timeMs > since; i--) count++;
  return count / (RATE_WINDOW_MS / 1000);
}

function drawDepthSide(ctx, levels, edgeX, bottom, color, priceToX, cumToY, isLight, maxQty, wet) {
  if (!levels.length) return;
  const xs = levels.map(l => priceToX(l.price));
  ctx.save();
  if (isLight) ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = color;
  levels.forEach((level, i) => {
    const x0 = xs[i];
    const x1 = xs[i + 1] ?? edgeX;
    const y = cumToY(level.cum);
    ctx.globalAlpha = (isLight ? 0.07 : 0.12) + (isLight ? 0.34 : 0.4) * Math.sqrt(level.qty / maxQty);
    ctx.fillRect(Math.min(x0, x1), y, Math.abs(x1 - x0), bottom - y);
  });
  ctx.restore();

  const traceSteps = () => {
    ctx.beginPath();
    ctx.moveTo(xs[0], bottom);
    let prevY = bottom;
    levels.forEach((level, i) => {
      const y = cumToY(level.cum);
      ctx.lineTo(xs[i], prevY);
      ctx.lineTo(xs[i], y);
      prevY = y;
    });
    ctx.lineTo(edgeX, prevY);
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  traceSteps();
  ctx.globalAlpha = (isLight ? 0.14 : 0.2) * (0.4 + wet);
  ctx.lineWidth = 2 + 7 * wet;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = isLight ? 1.5 : 1.7;
  ctx.stroke();
  ctx.restore();
}

export function drawBookDepth(view, market) {
  const { MUTED, GRID, UP, DOWN } = view.palette;
  const { ctx, w: width, h: height } = prepareSurface(view.bookDepth, view.palette);
  if (width < 10 || height < 10) {
    return;
  }

  const isLight = view.theme === 'light';
  const book = view.book ?? market.book();
  const ink = trackBookInk(view, market, book);
  const bids = [...ink.levels.values()].filter(l => l.side === 'buy');
  const asks = [...ink.levels.values()].filter(l => l.side === 'sell');
  const left = 6;
  const right = width - 6;
  const top = 12;
  const bottom = height - 14;

  if (!bids.length && !asks.length) return;

  const mid = book.bid !== null && book.ask !== null ? (book.bid + book.ask) / 2 : market.price;
  const span = Math.max(
    20,
    ...bids.map(l => Math.abs(mid - l.price)),
    ...asks.map(l => Math.abs(l.price - mid))
  ) * 1.08;
  const maxCum = Math.max(1, bids.at(-1)?.cum ?? 0, asks.at(-1)?.cum ?? 0);
  const maxQty = Math.max(1, ...bids.map(l => l.qty), ...asks.map(l => l.qty));
  const rate = tradeRate(market);
  const wet = 1 - Math.exp(-rate / 40);
  const sideColor = side => (side === 'buy' ? UP : DOWN);

  const scale = view.bookScale = easeScale(view.bookScale, { span, maxCum });
  const priceToX = p => left + ((p - (mid - scale.span)) / (scale.span * 2)) * (right - left);
  const cumToY = c => bottom - (Math.min(c, scale.maxCum) / scale.maxCum) * (bottom - top);
  const midX = priceToX(mid);
  drawLine(ctx, midX, top, midX, bottom, GRID, [2, 3]);

  drawDepthSide(ctx, bids, left, bottom, UP, priceToX, cumToY, isLight, maxQty, wet);
  drawDepthSide(ctx, asks, right, bottom, DOWN, priceToX, cumToY, isLight, maxQty, wet);

  ctx.save();
  ctx.lineCap = 'round';
  for (const wick of ink.wicks) {
    const w = inkWet(ink.clock, wick.bornMs, BOOK_WICK_MS);
    const rise = (1 - w) * 16;
    ctx.strokeStyle = sideColor(wick.side);
    ctx.globalAlpha = (isLight ? 0.26 : 0.34) * w;
    ctx.lineWidth = 1 + w;
    ctx.beginPath();
    ctx.moveTo(priceToX(wick.price), cumToY(wick.to) - rise);
    ctx.lineTo(priceToX(wick.price), cumToY(wick.from) - rise);
    ctx.stroke();
  }
  ctx.restore();

  for (const level of ink.levels.values()) {
    const w = levelInk(ink, level).wet;
    const radius = (3 + 14 * Math.sqrt(level.add / maxQty)) * (1.4 - 0.6 * w) * (0.8 + 0.4 * wet);
    drawInkBleed(ctx, priceToX(level.price), cumToY(level.cum), radius, w, sideColor(level.side), isLight);
  }
  for (const drop of ink.drops) {
    const w = inkWet(ink.clock, drop.bornMs, BOOK_BLOOM_MS);
    drawInkBleed(ctx, priceToX(drop.price), bottom, Math.min(9, 2 + Math.sqrt(drop.qty)) * (1.6 - 0.6 * w), 0.4 * w, sideColor(drop.side), isLight);
  }

}

export function drawMatrix(view, market) {
  const { INK, MUTED, GRID, ACCENT } = view.palette;
  const { ctx, w: width, h: height } = prepareSurface(view.matrix, view.palette);
  if (width < 10 || height < 10) {
    return;
  }

  const isLight = view.theme === 'light';
  const { types, volume, maxVolume } = counterpartyMatrix(market);
  const short = { maker: 'Maker', value: 'Value', trend: 'Trend', random: 'Random' };
  const left = 54;
  const top = 26;
  const right = width - 8;
  const bottom = height - 8;
  const cellW = (right - left) / types.length;
  const cellH = (bottom - top) / types.length;

  for (let c = 0; c < types.length; c++) {
    drawText(ctx, short[types[c]], left + (c + 0.5) * cellW, 15, { color: MUTED, align: 'center', weight: 500, family: 'sans' });
  }

  for (let r = 0; r < types.length; r++) {
    const y = top + r * cellH;
    drawText(ctx, short[types[r]], left - 6, y + cellH / 2 + 3, { color: MUTED, align: 'right', weight: 500, family: 'sans' });
    for (let c = 0; c < types.length; c++) {
      const x = left + c * cellW;
      const vol = volume[r][c];
      const intensity = maxVolume > 0 ? vol / maxVolume : 0;

      ctx.fillStyle = intensity > 0 ? ACCENT : GRID;
      ctx.globalAlpha = intensity > 0 ? 0.12 + 0.68 * Math.sqrt(intensity) : 0.25;
      ctx.fillRect(x + 1.5, y + 1.5, cellW - 3, cellH - 3);
      ctx.globalAlpha = 1;

      if (intensity > 0) {
        ctx.strokeStyle = isLight ? ACCENT : '#ffffff26';
        ctx.globalAlpha = isLight ? 0.22 + 0.35 * Math.sqrt(intensity) : 1;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4);
        ctx.globalAlpha = 1;
      }

      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 1.5, y + 1.5, cellW - 3, cellH - 3);

      if (vol > 0) {
        drawText(ctx, vol.toLocaleString('en-US'), x + cellW / 2, y + cellH / 2 + 3, {
          color: INK,
          align: 'center',
          weight: 500
        });
      } else {
        drawText(ctx, '—', x + cellW / 2, y + cellH / 2 + 3, { color: MUTED, align: 'center' });
      }
    }
  }
}

const EDGE_DASH = { maker: [], value: [6, 3], trend: [2, 3], random: [8, 3, 2, 3] };
export const EDGE_WINDOW_MS = 1800000;

export const edgeWindow = market => [
  ...market.edgeHistory.filter(p => p.timeMs >= market.timeMs - EDGE_WINDOW_MS),
  { timeMs: market.timeMs, edge: strategyEdges(market) }
];

export function drawEdge(view, market) {
  const { INK, MUTED, GRID, TYPE_INK } = view.palette;
  const { ctx, w: width, h: height } = prepareSurface(view.edge, view.palette);
  if (width < 10 || height < 10) return;

  const points = edgeWindow(market);
  const left = 40, right = width - 54, top = 8, bottom = height - 18;
  if (points.length < 2 || market.timeMs === points[0].timeMs) {
    return;
  }

  const types = Object.keys(points[0].edge);
  const startMs = points[0].timeMs;
  const limit = Math.max(1000, ...points.flatMap(p => types.map(t => Math.abs(p.edge[t])))) * 1.12;
  const timeToX = ms => left + ((ms - startMs) / (market.timeMs - startMs)) * (right - left);
  const edgeToY = value => (top + bottom) / 2 - (value / limit) * (bottom - top) / 2;

  const isLight = view.theme === 'light';
  for (const event of market.events) {
    if (event.releaseMs < startMs) continue;
    const x1 = timeToX(Math.max(startMs, event.startMs));
    const x2 = timeToX(Math.min(market.timeMs, event.releaseMs));
    ctx.fillStyle = newsColor(event.impact, isLight) + (isLight ? '1c' : '26');
    ctx.fillRect(x1, top, Math.max(1, x2 - x1), bottom - top);
  }

  for (const value of [limit / 2, -limit / 2]) {
    drawLine(ctx, left, edgeToY(value), right, edgeToY(value), GRID, [1, 4]);
    drawText(ctx, money(value), left - 6, edgeToY(value) + 3, { color: MUTED, align: 'right' });
  }
  drawLine(ctx, left, edgeToY(0), right, edgeToY(0), INK + '66');
  drawText(ctx, '0', left - 6, edgeToY(0) + 3, { color: MUTED, align: 'right' });

  for (const type of types) {
    drawPath(ctx, points.map(p => [timeToX(p.timeMs), edgeToY(p.edge[type])]), TYPE_INK[type], 2, EDGE_DASH[type]);
  }

  const last = points.at(-1).edge;
  const labels = types.map(type => ({ type, y: edgeToY(last[type]) })).sort((a, b) => a.y - b.y);
  labels.forEach((label, i) => { if (i) label.y = Math.max(label.y, labels[i - 1].y + 11); });
  const overflow = labels.at(-1).y - bottom;
  if (overflow > 0) labels.forEach(label => { label.y -= overflow; });
  for (const { type, y } of labels) {
    drawText(ctx, LANE_LABELS[type], right + 6, y + 3, { color: INK, weight: 500, family: 'sans' });
  }

  drawText(ctx, elapsed(startMs), left, height - 4);
  drawText(ctx, elapsed(market.timeMs), right, height - 4, { align: 'right' });

  const pointer = view.edgePointer;
  if (!pointer || pointer.x < left || pointer.x > right) return;
  const hovered = points.reduce((best, p) => Math.abs(timeToX(p.timeMs) - pointer.x) < Math.abs(timeToX(best.timeMs) - pointer.x) ? p : best);
  const x = timeToX(hovered.timeMs);
  drawLine(ctx, x, top, x, bottom, MUTED);
  for (const type of types) drawDot(ctx, x, edgeToY(hovered.edge[type]), TYPE_INK[type]);
  const rows = [elapsed(hovered.timeMs), ...types.map(t => `${LANE_LABELS[t].padEnd(7)}${money(hovered.edge[t]).padStart(7)}`)];
  const boxW = 120, boxH = rows.length * 12 + 8;
  const boxX = x + boxW + 10 > right ? x - boxW - 8 : x + 8;
  ctx.fillStyle = isLight ? '#f6f1e6f0' : '#1b1a18f0';
  ctx.fillRect(boxX, top, boxW, boxH);
  ctx.strokeStyle = GRID;
  ctx.strokeRect(boxX + 0.5, top + 0.5, boxW - 1, boxH - 1);
  rows.forEach((row, i) => drawText(ctx, row, boxX + 6, top + 14 + i * 12, { color: i ? INK : MUTED }));
}
