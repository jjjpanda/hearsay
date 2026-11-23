import { credits } from '../clock.js';
import { TYPES, activeMaker } from '../strategies.js';
import { agentMetrics } from '../metrics.js';
import { CANVAS_FONT, LANE_LABELS, drawGlyph, drawLine, drawText, prepareSurface } from './canvas.js';
import { drawAcrylicDab, drawPublicSweep, drawWatercolorBloom } from './ink.js';

export function drawField(view, market, delta, playing) {
  const isLight = view.theme === 'light';
  view.ink.update(market, delta, playing, view.reducedMotion, isLight);
  const { INK, MUTED, GRID, ACCENT, UP, DOWN, NEWS, TYPE_INK } = view.palette;
  const { ctx, w: width, h: height } = prepareSurface(view.canvas, view.palette);
  if (width < 10 || height < 10) {
    return;
  }

  const left = 54;
  const right = width - 10;
  const top = 24;
  const bottom = height - 22;
  const plotW = right - left;
  const plotH = bottom - top;
  if (plotW <= 0 || plotH <= 0) {
    return;
  }

  const awareness = view.fieldMode === 'awareness';
  const latestEvent = market.events.at(-1);
  const publicNews = Boolean(latestEvent && market.timeMs >= latestEvent.releaseMs);
  const knowsNews = agent => Boolean(latestEvent && (publicNews || agent.receivedEpisodeId === latestEvent.id));

  const laneHeight = plotH / TYPES.length;
  const domainKey = latestEvent?.id ?? 0;
  let low = market.price - 80;
  let high = market.price + 80;
  for (const agent of market.agents) {
    if (agent.belief < low) low = agent.belief;
    if (agent.belief > high) high = agent.belief;
  }
  const padding = Math.max(20, (high - low) * 0.1);
  const lower = Math.max(1, Math.floor((low - padding) / 50) * 50);
  const upper = Math.ceil((high + padding) / 50) * 50;
  if (!view.fieldDomain || view.fieldDomain.key !== domainKey) view.fieldDomain = { key: domainKey, low: lower, high: upper };
  else {
    if (low < view.fieldDomain.low) view.fieldDomain.low = lower;
    if (high > view.fieldDomain.high) view.fieldDomain.high = upper;
  }
  const domain = view.fieldDomain;
  const priceToX = value => left + ((value - domain.low) / (domain.high - domain.low)) * plotW;

  for (let i = 0; i < 3; i++) {
    const px = left + (i / 2) * plotW;
    drawLine(ctx, px, top, px, bottom, GRID, [2, 5]);
    drawText(ctx, credits(domain.low + (domain.high - domain.low) * i / 2), px, height - 6, {
      align: i === 0 ? 'left' : i === 2 ? 'right' : 'center'
    });
  }

  const book = view.book ?? market.book();
  if (book.bid !== null && book.ask !== null) {
    ctx.fillStyle = INK + '0a';
    const bidX = priceToX(book.bid);
    ctx.fillRect(bidX, top, Math.max(1, priceToX(book.ask) - bidX), plotH);
  }

  const currentPriceX = priceToX(market.price);
  drawLine(ctx, currentPriceX, top - 2, currentPriceX, bottom, INK + '66', [4, 4]);

  const bins = 24;
  const typeIndex = Object.fromEntries(TYPES.map((t, i) => [t, i]));
  const binCounts = Array.from({ length: TYPES.length }, () => Array(bins).fill(0));
  for (const agent of market.agents) {
    const ti = typeIndex[agent.type];
    if (ti === undefined) continue;
    const norm = (priceToX(agent.belief) - left) / plotW;
    const bin = Math.max(0, Math.min(bins - 1, Math.floor(norm * bins)));
    binCounts[ti][bin]++;
  }

  TYPES.forEach((type, index) => {
    const py = top + index * laneHeight;
    drawLine(ctx, left, py, right, py, GRID);

    const counts = binCounts[index];
    const smoothed = counts.map((_, i) =>
      (counts[Math.max(0, i - 1)] + 2 * counts[i] + counts[Math.min(bins - 1, i + 1)]) / 4
    );
    const maxBin = Math.max(1, ...smoothed);
    const ridgeBottom = py + laneHeight - 3;
    const ridgeHeight = laneHeight * 0.28;
    ctx.fillStyle = TYPE_INK[type] + '16';
    ctx.beginPath();
    ctx.moveTo(left, ridgeBottom);
    for (let i = 0; i < bins; i++) {
      const x = left + ((i + 0.5) / bins) * plotW;
      const y = ridgeBottom - (smoothed[i] / maxBin) * ridgeHeight;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(right, ridgeBottom);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < bins; i++) {
      const x = left + ((i + 0.5) / bins) * plotW;
      const y = ridgeBottom - (smoothed[i] / maxBin) * ridgeHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = TYPE_INK[type] + (isLight ? '44' : '38');
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.restore();

    const labelY = py + laneHeight * 0.5 + 3;
    drawText(ctx, LANE_LABELS[type], left - 7, labelY, {
      color: TYPE_INK[type],
      align: 'right',
      weight: 500,
      family: 'sans'
    });
  });
  drawLine(ctx, left, bottom, right, bottom, GRID);

  view.positions = market.agents.map(agent => ({
    id: agent.id,
    x: priceToX(agent.belief) + (agent.type === 'value' ? 0 : Math.sin(agent.id * 2.399963 + agent.jitter * Math.PI * 2) * 2),
    y: top + (TYPES.indexOf(agent.type) + 0.16 + agent.jitter * 0.68) * laneHeight
  }));

  const newTrades = market.trades.filter(trade => trade.id > view.lastTradeId);
  view.lastTradeId = market.tradeCount;

  const showConnections = !view.reducedMotion && view.playbackSpeed <= 16;
  if (showConnections) {
    view.connections.push(...newTrades.filter(trade => trade.origin === 'informed').slice(-3).map(trade => ({ ...trade, life: 1 })));
  } else view.connections = [];
  view.connections = view.connections.filter(trade => trade.life > 0).slice(-8);

  for (const trade of view.connections) {
    const sellerPos = view.positions[trade.seller];
    const buyerPos = view.positions[trade.buyer];
    if (!sellerPos || !buyerPos || Math.abs(sellerPos.y - buyerPos.y) > laneHeight * 1.25) {
      continue;
    }

    const midY = (sellerPos.y + buyerPos.y) / 2;
    const midX = (sellerPos.x + buyerPos.x) / 2 - Math.min(28, Math.abs(buyerPos.y - sellerPos.y) * 0.12 + 6);
    ctx.globalAlpha = trade.life * 0.3;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = Math.min(2.4, 0.8 + Math.log1p(trade.qty) * 0.35);
    ctx.beginPath();
    ctx.moveTo(sellerPos.x, sellerPos.y);
    ctx.quadraticCurveTo(midX, midY, buyerPos.x, buyerPos.y);
    ctx.stroke();

    if (playing) {
      trade.life -= delta / 520;
    }
  }
  ctx.globalAlpha = 1;

  let maxAbsPnl = 100;
  let maxAbsInv = 1;
  if (view.fieldMode === 'pnl') {
    for (const a of market.agents) {
      const v = Math.abs(a.cash + a.shares * market.price - a.initialWealth);
      if (v > maxAbsPnl) maxAbsPnl = v;
    }
  } else if (view.fieldMode === 'inventory') {
    for (const a of market.agents) {
      const v = Math.abs(a.shares - a.initialShares);
      if (v > maxAbsInv) maxAbsInv = v;
    }
  }

  const fluid = view.ink.fluid;
  if (view.fieldMode !== view.lastFieldMode) {
    fluid.reset();
    view.ink.injected.clear();
    view.ink.publicSweepFrac = 0;
    view.lastFieldMode = view.fieldMode;
  }
  if (fluid.ensureSize(plotW, plotH)) {
    view.ink.injected.clear();
    view.ink.publicSweepFrac = 0;
  }

  const wakeTick = playing && !view.reducedMotion && view.ink.clockMs - view.ink.lastWakeClockMs >= 80;
  if (awareness && latestEvent) {
    if (publicNews) {
      const midX = Math.max(8, Math.min(plotW - 8, currentPriceX - left));
      const settled = view.reducedMotion || view.ink.publicWet === 0;
      const progress = settled ? 1 : Math.min(1, (1 - view.ink.publicWet) / 0.38);
      if (progress > view.ink.publicSweepFrac) {
        fluid.injectMiddleSwell(
          midX,
          view.ink.publicSweepFrac * plotH,
          progress * plotH,
          settled ? 0.35 : 0.78,
          latestEvent.id * 3.17,
          'news',
          !settled
        );
        view.ink.publicSweepFrac = progress;
      }
    } else {
      for (const agent of market.agents) {
        if (!knowsNews(agent)) continue;
        if (view.ink.injected.has(agent.id)) continue;
        view.ink.injected.add(agent.id);
        const pos = view.positions[agent.id];
        const wet = view.reducedMotion ? 0 : view.ink.traderWet(agent.id);
        const seed = agent.id * 1.71 + latestEvent.id;
        if (view.reducedMotion || wet <= 0) {
          fluid.stampDryResidue(pos.x - left, pos.y - top, 11, 0.28, seed, 'news');
        } else {
          fluid.injectDroplet(
            pos.x - left,
            pos.y - top,
            11 + (agent.id % 4) * 1.6,
            0.52 + 0.34 * wet,
            seed,
            isLight ? 1.6 : 1.3,
            'news'
          );
        }
      }
    }
  } else if (!awareness && !view.ink.injected.has(-1)) {
    view.ink.injected.add(-1);
    for (const agent of market.agents) {
      const pos = view.positions[agent.id];
      const metric = view.fieldMode === 'pnl'
        ? agent.cash + agent.shares * market.price - agent.initialWealth
        : agent.shares - agent.initialShares;
      const norm = metric / (view.fieldMode === 'pnl' ? maxAbsPnl : maxAbsInv);
      if (Math.abs(norm) <= 0.18) continue;
      fluid.stampDryResidue(
        pos.x - left,
        pos.y - top,
        12 + Math.abs(norm) * 6,
        0.16 + Math.abs(norm) * 0.16,
        agent.id * 1.9,
        norm > 0 ? 'up' : 'down'
      );
    }
  }

  if (wakeTick) {
    view.ink.lastWakeClockMs = view.ink.clockMs;
    if (!awareness && newTrades.length > 0) {
      let topMover = null;
      let topNorm = 0.25;
      for (const agent of market.agents) {
        const metric = view.fieldMode === 'pnl'
          ? agent.cash + agent.shares * market.price - agent.initialWealth
          : agent.shares - agent.initialShares;
        const norm = Math.abs(metric) / (view.fieldMode === 'pnl' ? maxAbsPnl : maxAbsInv);
        if (norm > topNorm) { topNorm = norm; topMover = { agent, metric, norm }; }
      }
      if (topMover) {
        const pos = view.positions[topMover.agent.id];
        fluid.injectDroplet(
          pos.x - left,
          pos.y - top,
          12,
          0.22 * Math.min(1, topMover.norm),
          topMover.agent.id + market.timeMs * 0.001,
          isLight ? 1.0 : 0.8,
          topMover.metric > 0 ? 'up' : 'down'
        );
      }
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, plotW, plotH);
  ctx.clip();
  if (fluid.hasPaint) {
    fluid.render(ctx, left, top, plotW, plotH, isLight);
  }
  if (awareness && latestEvent) {
    if (publicNews) {
      const sweepWet = view.reducedMotion ? 0 : view.ink.publicWet;
      drawPublicSweep(ctx, currentPriceX, top, plotH, view.ink.publicSweepFrac, sweepWet, view.palette, isLight);
    } else if (!view.reducedMotion) {
      for (const agent of market.agents) {
        if (!knowsNews(agent)) continue;
        const wet = view.ink.traderWet(agent.id);
        if (wet <= 0.03) continue;
        const pos = view.positions[agent.id];
        const seed = agent.id * 1.71 + latestEvent.id;
        const radius = 8.5 + (agent.id % 4) * 1.8 + wet * 3.5;
        if (isLight) drawWatercolorBloom(ctx, pos.x, pos.y, radius, wet, seed, NEWS, 1);
        else drawAcrylicDab(ctx, pos.x, pos.y, radius, wet, NEWS);
      }
    }
  }
  ctx.restore();
  const hoveredId = view.fieldPointer ? view.hit(view.fieldPointer.x, view.fieldPointer.y) : null;

  for (const agent of market.agents) {
    const pos = view.positions[agent.id];
    const isInactive = agent.type === 'maker' && !activeMaker(market, agent);
    const isSelected = agent.id === view.selected;
    const isHovered = agent.id === hoveredId;
    const informed = knowsNews(agent);

    let color = awareness && informed ? NEWS : TYPE_INK[agent.type];
    let alpha = isInactive ? 0.25 : isSelected || isHovered ? 1 : 0.85;

    if (view.fieldMode === 'pnl') {
      const pnl = agent.cash + agent.shares * market.price - agent.initialWealth;
      color = pnl > 0 ? UP : pnl < 0 ? DOWN : MUTED;
      if (!isInactive && !isSelected && !isHovered) {
        alpha = 0.3 + 0.7 * Math.min(1, Math.abs(pnl) / maxAbsPnl);
      }
    } else if (view.fieldMode === 'inventory') {
      const inv = agent.shares - agent.initialShares;
      color = inv > 0 ? UP : inv < 0 ? DOWN : MUTED;
      if (!isInactive && !isSelected && !isHovered) {
        alpha = 0.3 + 0.7 * Math.min(1, Math.abs(inv) / maxAbsInv);
      }
    }

    const r = isSelected ? 4.5 : isHovered ? 4 : 3;
    const darkInformed = !isLight && awareness && latestEvent && informed;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = darkInformed ? '#bfe2ff' : color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    drawGlyph(ctx, agent.type, pos.x, pos.y, r, !awareness || !latestEvent || informed);
    if (darkInformed) {
      ctx.strokeStyle = '#0d1014f0';
      ctx.lineWidth = 1.2;
      drawGlyph(ctx, agent.type, pos.x, pos.y, r, false);
    }

    if (isSelected || isHovered) {
      ctx.globalAlpha = isSelected ? 1 : 0.6;
      ctx.strokeStyle = isLight ? '#f4eee0' : '#16191e';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, isSelected ? 8 : 6.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = INK;
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  if (hoveredId !== null) {
    const a = market.agents[hoveredId];
    const m = agentMetrics(market, a);
    const pnlStr = `${m.pnl >= 0 ? '+' : '−'}$${credits(Math.abs(Math.round(m.pnl)))}`;
    const invStr = `${m.invDelta >= 0 ? '+' : ''}${m.invDelta}`;
    drawText(ctx, `#${a.id + 1} ${a.type} · thinks $${credits(a.belief)} · ${pnlStr} · ${invStr} shares`, left, 13, {
      color: INK, weight: 500
    });
  } else {
    ctx.font = `500 10px ${CANVAS_FONT}`;
    const pLabel = `price ${credits(market.price)}`;
    const half = ctx.measureText(pLabel).width / 2;
    const pX = Math.max(left + half + 2, Math.min(right - half - 2, currentPriceX));
    drawText(ctx, pLabel, pX, 13, { color: INK, align: 'center', weight: 500 });
  }
}
