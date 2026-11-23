import { credits, elapsed } from '../clock.js';
import { candleSeries, autoInterval, HISTORY_MS, TICK_SIZES } from '../analytics.js';
import { drawDot, drawLine, drawPath, drawText, prepareSurface } from './canvas.js';
import { drawBrushStroke, drawInkWashBand, newsColor } from './ink.js';

function drawNewsMarkers(ctx, view, market, { top, bottom, startMs, endMs = market.timeMs, timeToX }) {
  const isLight = view.theme === 'light';
  const focusId = view.selectedEventId ?? market.events.at(-1)?.id ?? null;
  for (const event of market.events) {
    if (event.releaseMs < startMs || event.startMs > endMs) continue;
    const selected = event.id === focusId;
    const epochColor = newsColor(event.impact, isLight);
    const bandStart = Math.max(startMs, event.startMs);
    const bandEnd = Math.min(endMs, event.releaseMs);
    if (bandEnd > bandStart) {
      const x1 = timeToX(bandStart);
      const x2 = timeToX(bandEnd);
      drawInkWashBand(ctx, x1, top, x2 - x1, bottom - top, 1, event.id * 1.7, isLight, event.impact, selected ? 1.0 : 0.52);
    }
    if (event.releaseMs <= endMs) {
      const x = timeToX(event.releaseMs);
      drawBrushStroke(ctx, x, top + 13, x, bottom, 2.2, epochColor, event.id * 2.9, selected ? 0.9 : 0.5);
      drawText(ctx, 'P', x, top + 10, { color: epochColor + (selected ? 'ff' : 'cc'), align: 'center', weight: 700 });
    }
  }

  view.markers = market.events
    .flatMap(event => [event.startMs, event.releaseMs].filter(ms => ms >= startMs && ms <= endMs)
      .map(ms => ({ id: event.id, x: timeToX(ms), event, release: ms === event.releaseMs })));
  for (const marker of view.markers) {
    if (marker.release) continue;
    const selected = marker.id === focusId;
    const epochColor = newsColor(marker.event.impact, isLight);
    drawLine(ctx, marker.x, top + 13, marker.x, bottom, epochColor + (selected ? 'eb' : '88'), [2, 4]);
    drawText(ctx, marker.event.impact > 0 ? '+' : '−', marker.x, top + 10, { color: epochColor + (selected ? 'ff' : 'cc'), align: 'center', weight: 700 });
  }
}

const OVERLAY_LEVELS = 8;

function drawOverlay(ctx, view, market, { left, right, top, bottom }, priceToY) {
  const { UP, DOWN } = view.palette;
  const zone = Math.min(120, (right - left) * 0.2);
  const book = view.book ?? market.book();
  const levels = [...book.buyLevels.slice(0, OVERLAY_LEVELS).map(l => [l, UP]), ...book.sellLevels.slice(0, OVERLAY_LEVELS).map(l => [l, DOWN])];
  const maxQty = Math.max(1, ...levels.map(([l]) => l.qty));
  const rowH = Math.max(1.5, Math.abs(priceToY(0) - priceToY(1)) * 0.8);

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  ctx.globalAlpha = 0.25;
  for (const [level, color] of levels) {
    const w = Math.sqrt(level.qty / maxQty) * zone;
    ctx.fillStyle = color;
    ctx.fillRect(right - w, priceToY(level.price) - rowH / 2, w, rowH);
  }
  ctx.restore();
}

function drawPriceTicks(ctx, left, right, height, priceLow, priceHigh, priceToY, gridColor) {
  const ticks = height >= 360 ? 5 : 3;
  for (let i = 0; i < ticks; i++) {
    const value = priceLow + ((priceHigh - priceLow) * i) / (ticks - 1);
    const py = priceToY(value);
    drawLine(ctx, left, py, right, py, gridColor, [2, 4]);
    drawText(ctx, credits(value), left - 7, py + 3, { align: 'right' });
  }
}

function timeWindow(view, market, plotWidth, snap) {
  const slots = Math.floor(plotWidth / 6);
  const intervalSeconds = view.candleSeconds || autoInterval(1800000, plotWidth);
  const intervalMs = intervalSeconds * 1000;
  const windowMs = view.candleSeconds ? Math.min(HISTORY_MS, slots * intervalMs) : 1800000;
  const maxOffsetMs = Math.max(0, Math.min(HISTORY_MS, market.timeMs) - windowMs);
  view.historyOffsetMs = Math.max(0, Math.min(maxOffsetMs, view.historyOffsetMs));

  const rawEndMs = Math.max(snap ? 0 : intervalMs, market.timeMs - view.historyOffsetMs);
  const endMs = snap ? (Math.floor(rawEndMs / intervalMs) + 1) * intervalMs : rawEndMs;
  const startMs = Math.max(0, endMs - windowMs);
  const spanMs = Math.max(snap ? intervalMs * 12 : intervalMs, endMs - startMs);
  const axisEndMs = snap ? startMs + spanMs : endMs;
  const dataEndMs = Math.min(market.timeMs, rawEndMs);
  view.historySpanMs = spanMs;

  return { slots, intervalSeconds, intervalMs, windowMs, rawEndMs, startMs, endMs, spanMs, axisEndMs, dataEndMs };
}

function markerTooltip(view) {
  const marker = view.pointer && view.markers.find(m => Math.abs(m.x - view.pointer.x) < 10);
  return marker
    ? `${elapsed(marker.event.startMs)} · ${marker.event.impact > 0 ? '+' : ''}${marker.event.impact}% shock · public ${elapsed(marker.event.releaseMs)}`
    : '';
}

function drawCandles(ctx, view, market, width, height, { left, right, top, bottom }) {
  const { GRID, UP, DOWN } = view.palette;
  const isLight = view.theme === 'light';
  const byTick = view.chartMode === 'tick';
  const win = timeWindow(view, market, right - left, true);

  const tickSize = TICK_SIZES.includes(view.tickSize) ? view.tickSize : TICK_SIZES[1];
  const tickSeries = market.tickCandles[TICK_SIZES.indexOf(tickSize)];
  const maxTickOffset = Math.max(0, tickSeries.length - win.slots);
  view.tickOffset = Math.max(0, Math.min(maxTickOffset, view.tickOffset));
  const tickEnd = tickSeries.length - view.tickOffset;
  const candles = byTick
    ? tickSeries.slice(Math.max(0, tickEnd - win.slots), tickEnd)
    : candleSeries(market, Math.max(0, win.rawEndMs - win.startMs) / 1000, win.intervalSeconds, win.rawEndMs);

  const timeToX = ms => left + ((ms - win.startMs) / win.spanMs) * (right - left);

  if (candles.length === 0) {
    if (!byTick) drawNewsMarkers(ctx, view, market, { top, bottom, startMs: win.startMs, endMs: win.dataEndMs, timeToX });
    return;
  }

  const [priceLowRaw, priceHighRaw] = [Math.min(...candles.map(c => c.low)), Math.max(...candles.map(c => c.high))];
  const padding = Math.max(10, (priceHighRaw - priceLowRaw) * 0.1);
  const priceLow = priceLowRaw - padding;
  const priceHigh = priceHighRaw + padding;
  const priceToY = value => bottom - ((value - priceLow) / (priceHigh - priceLow)) * (bottom - top);

  drawPriceTicks(ctx, left, right, height, priceLow, priceHigh, priceToY, GRID);
  if (view.embed) drawOverlay(ctx, view, market, { left, right, top, bottom }, priceToY);

  const slot = byTick ? (right - left) / Math.max(candles.length, 8) : ((right - left) * win.intervalSeconds * 1000) / win.spanMs;
  const bodyWidth = Math.max(1, Math.min(18, slot * 0.7));
  const xOf = (candle, index) =>
    byTick ? left + (index + 0.5) * slot : Math.max(left + bodyWidth / 2, Math.min(right - bodyWidth / 2, timeToX(candle.timeMs) + slot / 2));

  if (byTick) {
    const times = [...candles.map(c => c.timeMs), tickSeries[tickEnd]?.timeMs ?? market.timeMs];
    drawNewsMarkers(ctx, view, market, {
      top, bottom, startMs: times[0], endMs: times.at(-1),
      timeToX: ms => {
        let i = 0;
        while (i < candles.length - 1 && times[i + 1] <= ms) i++;
        const span = times[i + 1] - times[i];
        return left + (i + (span > 0 ? Math.min(1, Math.max(0, (ms - times[i]) / span)) : 0)) * slot;
      }
    });
  } else {
    drawNewsMarkers(ctx, view, market, { top, bottom, startMs: win.startMs, endMs: win.dataEndMs, timeToX });
  }

  const maxVolume = Math.max(1, ...candles.map(c => c.volume));
  const volHeight = (bottom - top) * 0.18;
  const makeVolGrad = color => {
    const grad = ctx.createLinearGradient?.(0, bottom - volHeight, 0, bottom);
    if (!grad) return color + (isLight ? '26' : '33');
    grad.addColorStop(0, color + (isLight ? '38' : '48'));
    grad.addColorStop(1, color + (isLight ? '10' : '18'));
    return grad;
  };
  const upVolFill = makeVolGrad(UP);
  const downVolFill = makeVolGrad(DOWN);

  if (market.tradeCount > 0 && (byTick ? view.tickOffset === 0 : view.historyOffsetMs === 0)) {
    const lastY = priceToY(market.price);
    drawLine(ctx, left, lastY, right, lastY, view.palette.INK + '55', [3, 3]);
  }

  candles.forEach((candle, index) => {
    const x = Math.round(xOf(candle, index)) + 0.5;
    const bullish = candle.close >= candle.open;
    const color = bullish ? UP : DOWN;
    const barH = (candle.volume / maxVolume) * volHeight;
    if (barH > 0.5) {
      const barX = x - bodyWidth / 2;
      const barY = bottom - barH;
      ctx.fillStyle = bullish ? upVolFill : downVolFill;
      ctx.fillRect(barX, barY, bodyWidth, barH);
      drawBrushStroke(ctx, barX, barY + 0.5, barX + bodyWidth, barY + 0.5, 2, color, index * 1.3, isLight ? 0.55 : 0.5);
    }
    if (view.chartLine) return;
    const bodyTop = priceToY(Math.max(candle.open, candle.close));
    const bodyHeight = Math.max(1.5, Math.abs(priceToY(candle.open) - priceToY(candle.close)));
    const highY = priceToY(candle.high);
    const lowY = priceToY(candle.low);
    const bodyBottom = bodyTop + bodyHeight;
    if (bodyTop - highY > 0.5) drawBrushStroke(ctx, x, highY, x, bodyTop, 1.7, color, index * 0.7 + 1);
    if (lowY - bodyBottom > 0.5) drawBrushStroke(ctx, x, bodyBottom, x, lowY, 1.7, color, index * 0.7 + 2);
    const bx = x - bodyWidth / 2;
    ctx.clearRect(bx, bodyTop, bodyWidth, bodyHeight);
    ctx.save();
    if (isLight) ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.14;
    ctx.fillRect(bx - 1, bodyTop - 1, bodyWidth + 2, bodyHeight + 2);
    const pool = ctx.createLinearGradient?.(0, bodyTop, 0, bodyTop + bodyHeight);
    if (pool) {
      pool.addColorStop(0, color + 'a8');
      pool.addColorStop(1, color + 'f0');
      ctx.fillStyle = pool;
    }
    ctx.globalAlpha = isLight ? 0.85 : 0.95;
    ctx.fillRect(bx, bodyTop, bodyWidth, bodyHeight);
    if (bodyWidth >= 3 && bodyHeight >= 3) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.9;
      ctx.globalAlpha = 0.9;
      ctx.strokeRect(bx + 0.45, bodyTop + 0.45, bodyWidth - 0.9, bodyHeight - 0.9);
    }
    ctx.restore();
  });

  if (view.chartLine) {
    const points = candles.map((candle, index) => [xOf(candle, index), priceToY(candle.close)]);
    drawPath(ctx, points, view.palette.INK, 1.5, []);
    if (points.length <= 45) points.forEach(([x, y]) => drawDot(ctx, x, y, view.palette.INK));
  }

  drawText(ctx, elapsed(byTick ? candles[0].timeMs : win.startMs), left, height - 6);
  drawText(ctx, byTick ? elapsed(candles.at(-1).timeMs) : elapsed(win.axisEndMs), right, height - 6, { align: 'right' });

  const hovered =
    view.pointer &&
    candles.find((candle, index) => Math.abs(xOf(candle, index) - view.pointer.x) <= Math.max(slot / 2, 3));
  if (view.pointer && view.pointer.x >= left && view.pointer.x <= right && view.pointer.y >= top && view.pointer.y <= bottom) {
    drawLine(ctx, view.pointer.x, top, view.pointer.x, bottom, GRID);
  }
  if (hovered) {
    const quote = `O ${credits(hovered.open)} · H ${credits(hovered.high)} · L ${credits(hovered.low)} · C ${credits(hovered.close)}`;
    drawText(ctx, width < 600 ? quote : `${quote} · ${hovered.trades}t · ${hovered.volume}v`, left + 4, 11, {
      color: view.palette.INK
    });
  }
  view.history.title = hovered
    ? `${elapsed(hovered.timeMs)} · open ${credits(hovered.open)} · high ${credits(hovered.high)} · low ${credits(hovered.low)} · close ${credits(hovered.close)} · ${hovered.trades} trades · ${hovered.volume} vol`
    : markerTooltip(view);
}

export function drawHistory(view, market) {
  view.markers = [];
  const { INK, GRID, ACCENT } = view.palette;
  const { ctx, w: width, h: height } = prepareSurface(view.history, view.palette);
  if (width < 10 || height < 10) {
    return;
  }

  const bounds = { left: 50, right: width - 10, top: 20, bottom: height - 22 };
  const { left, right, top, bottom } = bounds;

  if (!view.chartLine || view.chartMode === 'tick') {
    drawCandles(ctx, view, market, width, height, bounds);
    return;
  }

  const win = timeWindow(view, market, right - left, false);
  const blocks = candleSeries(market, win.windowMs / 1000, win.intervalSeconds, win.dataEndMs);
  const sampledValues = blocks.length ? blocks.map(b => b.close) : [market.price];

  const [priceLowRaw, priceHighRaw] = [Math.min(...sampledValues), Math.max(...sampledValues)];
  const padding = Math.max(10, (priceHighRaw - priceLowRaw) * 0.15);
  const priceLow = priceLowRaw - padding;
  const priceHigh = priceHighRaw + padding;

  const timeToX = ms => left + ((ms - win.startMs) / win.spanMs) * (right - left);
  const priceToY = value => bottom - ((value - priceLow) / (priceHigh - priceLow)) * (bottom - top);

  const firstBlock = Math.ceil(win.startMs / win.intervalMs) * win.intervalMs;
  const blockCount = Math.floor((win.endMs - firstBlock) / win.intervalMs);
  const blockStep = Math.max(1, Math.ceil(blockCount / 40));
  for (let t = firstBlock, idx = 0; t <= win.endMs; t += win.intervalMs, idx++) {
    if (idx % blockStep !== 0) continue;
    const bx = timeToX(t);
    drawLine(ctx, bx, top, bx, bottom, GRID, [1, 4]);
  }

  drawPriceTicks(ctx, left, right, height, priceLow, priceHigh, priceToY, GRID);
  if (view.embed) drawOverlay(ctx, view, market, bounds, priceToY);

  drawText(ctx, elapsed(win.startMs), left, height - 6);
  drawText(ctx, elapsed(win.endMs), right, height - 6, { align: 'right' });

  drawNewsMarkers(ctx, view, market, { top, bottom, startMs: win.startMs, endMs: win.dataEndMs, timeToX });

  const blockPts = blocks.map(b => ({
    block: b,
    x: timeToX(Math.min(win.endMs, b.timeMs + win.intervalMs)),
    y: priceToY(b.close)
  }));

  if (blockPts.length > 0) {
    if (blockPts.length >= 2) {
      const grad = ctx.createLinearGradient?.(0, top, 0, bottom);
      if (grad) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(blockPts[0].x, bottom);
        for (const p of blockPts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(blockPts.at(-1).x, bottom);
        ctx.closePath();
        grad.addColorStop(0, INK + (view.theme === 'light' ? '1a' : '22'));
        grad.addColorStop(1, INK + '00');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      }
    }
    drawPath(ctx, blockPts.map(p => [p.x, p.y]), INK, 1.5, []);
    if (blockPts.length <= 45) {
      for (const p of blockPts) drawDot(ctx, p.x, p.y, INK);
    }
  }

  let hoveredBlock = null;
  if (view.pointer && view.pointer.x >= left && view.pointer.x <= right && view.pointer.y >= top && view.pointer.y <= bottom) {
    drawLine(ctx, view.pointer.x, top, view.pointer.x, bottom, GRID);
    if (blockPts.length) {
      let bestDist = Infinity;
      for (const pt of blockPts) {
        const d = Math.abs(pt.x - view.pointer.x);
        if (d < bestDist) {
          bestDist = d;
          hoveredBlock = pt;
        }
      }
      if (hoveredBlock) {
        drawDot(ctx, hoveredBlock.x, hoveredBlock.y, ACCENT);
        const b = hoveredBlock.block;
        drawText(
          ctx,
          width < 600 ? `${elapsed(b.timeMs)} · close ${credits(b.close)}` : `${elapsed(b.timeMs)} · close ${credits(b.close)} (O ${credits(b.open)} H ${credits(b.high)} L ${credits(b.low)} · ${b.trades}t)`,
          left + 4,
          11,
          { color: INK }
        );
      }
    }
  }

  view.history.title = hoveredBlock
    ? `${elapsed(hoveredBlock.block.timeMs)} · close ${credits(hoveredBlock.block.close)} · ${hoveredBlock.block.trades} trades`
    : markerTooltip(view);
}
