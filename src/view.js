import { createModel } from './model.js';
import { PALETTES, sampleModelAt } from './views/canvas.js';
import { drawField } from './views/field.js';
import { drawHistory } from './views/history.js';
import { drawBookDepth, drawEdge, drawEpisode, drawFlow, drawMatrix } from './views/panels.js';
import { InkPlayback } from './views/ink.js';

export class MarketView {
  constructor(fieldCanvas, historyCanvas, flowCanvas = null, episodeCanvas = null, bookCanvas = null, matrixCanvas = null, edgeCanvas = null) {
    this.canvas = fieldCanvas;
    this.history = historyCanvas;
    this.flow = flowCanvas;
    this.episode = episodeCanvas;
    this.bookDepth = bookCanvas;
    this.matrix = matrixCanvas;
    this.edge = edgeCanvas;
    this.edgePointer = null;
    this.theme = 'dark';

    this.selected = null;
    this.chartMode = 'time';
    this.chartLine = false;
    this.candleSeconds = 0;
    this.tickSize = 12;
    this.logCounts = true;
    this.fieldMode = 'awareness';
    this.activeTab = null;
    this.embed = false;
    this.playbackSpeed = 64;
    this.selectedEventId = null;
    this.historyOffsetMs = 0;
    this.tickOffset = 0;
    this.historySpanMs = 1800000;
    this.positions = [];
    this.connections = [];
    this.ink = new InkPlayback();
    this.lastTradeId = 0;
    this.curveCache = null;
    this._episodeDiscCache = null;
    this.flowLabelSource = null;
    this.flowLabelTotal = null;
    this.pointer = null;
    this.fieldPointer = null;
    this.flowPointer = null;
    this.markers = [];
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  reset(market) {
    this.book = null;
    this.ink.reset();
    this.fieldDomain = null;
    this.positions = [];
    this.connections = [];
    this.lastTradeId = market.tradeCount;
    this.selected = null;
    this.selectedEventId = null;
    this.markers = [];
    this.flowLabelSource = null;
    this.flowLabelTotal = null;
    this.historyOffsetMs = 0;
    this.tickOffset = 0;
    this._episodeDiscCache = null;
    this.bookScale = null;
    this.book = null;
  }

  episodeCurve(model, span, params, steps = 80, context = {}) {
    const key = JSON.stringify([span, params, steps, model.stateDependent === false ? null : context]);
    if (this.curveCache?.model !== model || this.curveCache.key !== key) {
      const provider = createModel(model);
      let share = 0;
      const samples = Array.from({ length: steps + 1 }, (_, i) => {
        const point = sampleModelAt(provider, (i / steps) * span, span, params, context);
        point.share = share = Math.max(share, point.share);
        return point;
      });
      this.curveCache = { model, key, curve: { samples, peak: samples.reduce((best, p) => (p.rate > best.rate ? p : best)) } };
    }
    return this.curveCache.curve;
  }

  get palette() {
    return PALETTES[this.theme] || PALETTES.dark;
  }

  hit(x, y) {
    let closestId = null;
    let nearestDistance = 12;

    for (const pos of this.positions) {
      const distance = Math.hypot(x - pos.x, y - pos.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        closestId = pos.id;
      }
    }

    return closestId;
  }

  draw(market, delta = 16, playing = true) {
    if (this.canvas && !this.embed && (!this.activeTab || this.activeTab === 'traders')) {
      drawField(this, market, delta, playing);
    } else {
      this.ink.update(market, delta, playing, this.reducedMotion, this.theme === 'light');
    }
    drawHistory(this, market);
    if (this.flow && !this.embed && (!this.activeTab || this.activeTab === 'flow')) {
      drawFlow(this, market);
    }
    if (this.episode && !this.embed && (!this.activeTab || this.activeTab === 'news')) {
      drawEpisode(this, market);
    }
    if (this.bookDepth && !this.embed && (!this.activeTab || this.activeTab === 'book')) {
      drawBookDepth(this, market);
    }
    if (this.matrix && !this.embed && (!this.activeTab || this.activeTab === 'ledger')) {
      drawMatrix(this, market);
    }
    if (this.edge && !this.embed && (!this.activeTab || this.activeTab === 'ledger')) {
      drawEdge(this, market);
    }
  }

  drawField(market, delta, playing) {
    drawField(this, market, delta, playing);
  }

  drawHistory(market) {
    drawHistory(this, market);
  }

  drawFlow(market) {
    drawFlow(this, market);
  }

  drawEpisode(market) {
    drawEpisode(this, market);
  }

  drawBookDepth(market) {
    drawBookDepth(this, market);
  }

  drawMatrix(market) {
    drawMatrix(this, market);
  }
}
