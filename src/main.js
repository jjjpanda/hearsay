import { Market } from './sim.js';
import { MarketView } from './view.js';
import { renderInterface, intervalOptions } from './template.js';
import { CONDITION_KEYS, ENGINE_CONFIG, NEUTRAL, RATIO_KEYS, DEFAULT_RATIOS } from './model.js';
import { Playback } from './playback.js';
import { PRESETS, OPTION_NAMES, readOptions } from './options.js';
import { marketMetrics, strategyMetrics } from './metrics.js';
import { credits } from './clock.js';
import { updateBook, updateDiagnostics, updateFigures, updateNews } from './panels.js';
import { onPaperReady } from './views/ink.js';

export class MarketEcosystem extends HTMLElement {
  static observedAttributes = [...OPTION_NAMES];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.playback = new Playback();
    this.frameId = null;
    this.dirty = true;
    this.canvasDirty = true;
    this.activeTab = 'traders';
    this.eventStamp = null;
    this.syncedEventId = null;
    this.flowModel = NEUTRAL;
  }

  get options() {
    return readOptions(name => this.getAttribute(name));
  }

  attributeChangedCallback(name, previous, value) {
    if (previous === value || !this.market) return;
    this.applyOption(name);
    if (name === 'seed') this.reset();
    this.refresh();
  }

  applyOption(name) {
    const options = this.options;
    if (name === 'seed') this.el('seed').value = options.seed;
    if (name === 'population') {
      this.el('population-input').value = options.population;
      if (this.market && this.market.agents.length !== options.population) {
        this.market.setPopulation(options.population);
      }
    }
    if (name === 'speed') {
      this.playback.speed = options.speed;
      this.playback.clear();
      this.el('speed').value = options.speed;
    }
    if (name === 'autoplay') {
      this.playback.playing = options.autoplay;
      this.playback.clear();
    }
    if (name === 'preset') {
      this.el('preset').value = options.preset;
      for (const key of CONDITION_KEYS) this.el(key).value = PRESETS[options.preset][key];
      if (this.market) {
        this.market.configure(this.settings());
        this.market.setArrivalRate(PRESETS[options.preset].activity);
      }
    }
    if (name === 'theme') {
      this.view.theme = options.theme;
      this.el('theme').value = options.theme;
    }
    if (name === 'embed') this.view.embed = options.embed;
    if (name === 'width') this.style.width = options.width ? `min(100%, ${options.width}px)` : '';
    if (name === 'height') {
      this.style.height = options.height ? `${options.height}px` : '';
      this.style.overflowY = options.height ? 'auto' : '';
    }
    if (name === 'panels') {
      const allowed = options.panels;
      this.shadowRoot.querySelectorAll?.('[data-panel]').forEach(panel => {
        panel.hidden = Boolean(allowed && !allowed.includes(panel.dataset.panel));
      });
      this.view.activeTab = allowed ? null : this.activeTab;
    }
    if (name === 'autofocus' && options.autofocus && this.isConnected) this.el('market').focus();
  }

  get metrics() {
    if (!this.market) return null;
    const book = this.market.book();
    return {
      timeMs: this.market.timeMs,
      price: this.market.price,
      value: this.market.value,
      tradeCount: this.market.tradeCount,
      volatilityBps: this.market.volatility,
      market: marketMetrics(this.market, book),
      strategies: strategyMetrics(this.market),
      flow: this.market.flow
    };
  }

  get model() {
    return this.flowModel;
  }

  get episodeKeys() {
    return this.model.params.map(([key]) => key);
  }

  input(key) {
    return this.el(this.episodeKeys.includes(key) ? `p-${key}` : key);
  }

  get playing() {
    return this.playback.playing;
  }

  get speed() {
    return this.playback.speed;
  }

  connectedCallback() {
    if (!this.market) {
      this.start();
    }

    this.lifecycle = new AbortController();
    const signal = this.lifecycle.signal;

    document.addEventListener(
      'visibilitychange',
      () => {
        this.playback.clear();
        this.dirty = true;
      },
      { signal }
    );

    this.shadowRoot.addEventListener('keydown', event => this.onKey(event), { signal });

    this.observer = new ResizeObserver(() => {
      this.view?.ink?.fluid?.invalidateLayout();
      this.canvasDirty = true;
    });
    this.observer.observe(this);

    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.motion.addEventListener(
      'change',
      event => {
        this.view.reducedMotion = event.matches;
        this.view.connections = [];
        this.canvasDirty = true;
      },
      { signal }
    );

    this.shadowRoot.querySelector('link').addEventListener(
      'load',
      () => {
        this.canvasDirty = true;
      },
      { once: true }
    );

    const stopPaperReady = onPaperReady(() => {
      this.canvasDirty = true;
    });
    signal.addEventListener('abort', stopPaperReady, { once: true });

    this.animate();
    if (this.options.autofocus) this.el('market').focus();
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.frameId);
    this.observer?.disconnect();
    this.lifecycle?.abort();
    this.playback.clear();
  }

  start() {
    this.shadowRoot.innerHTML = `<link rel="stylesheet" href="${new URL('./style.css', import.meta.url)}">${renderInterface(this.model)}`;
    this.el = id => this.shadowRoot.getElementById(id);

    this.view = new MarketView(
      this.el('field'),
      this.el('history'),
      this.el('flow'),
      this.el('episode'),
      this.el('book-depth'),
      this.el('matrix'),
      this.el('edge')
    );
    this.view.activeTab = this.activeTab;
    for (const name of OPTION_NAMES) this.applyOption(name);
    this.renderRandomNews(true);
    this.bind();
    this.reset();
  }

  settings() {
    const keys = [...CONDITION_KEYS, ...this.episodeKeys];
    const values = Object.fromEntries(keys.map(k => [k, Number(this.input(k).value)]));
    return {
      ...values,
      privateWindowSeconds: Number(this.el('news-duration').value)
    };
  }

  ratios() {
    const raw = Object.fromEntries(RATIO_KEYS.map(k => [k, Number(this.el(`ratio-${k}`).value)]));
    const total = RATIO_KEYS.reduce((s, k) => s + raw[k], 0);
    return total > 0 ? raw : { ...DEFAULT_RATIOS };
  }

  reset() {
    try {
      const market = new Market({
        model: this.model,
        seed: Number(this.el('seed').value),
        population: Number(this.el('population-input').value),
        ratios: this.ratios(),
        ...this.settings()
      });

      this.market = market;
      this.playback.clear();
      this.view.reset(market);
      this.eventStamp = null;
      this.syncedEventId = null;
      this.el('notice').textContent = '';
      this.el('news-feedback').textContent = '';
      market.setRandomEpisodes(this.randomNews(), Number(this.el('auto-rate').value));

      this.refresh();
    } catch (error) {
      this.el('notice').textContent = error.message;
    }
  }

  bind() {
    this.bindTransportControls();
    this.bindConfigurationControls();
    this.bindInformationControls();
    this.bindCanvasInteractions();
    this.bindDockTabs();
  }

  bindDockTabs() {
    const tabs = this.shadowRoot.querySelectorAll?.('.dock-tab');
    if (!tabs?.length) return;
    tabs.forEach(tab => {
      tab.onclick = () => this.activateTab(tab.dataset.tab);
    });
  }

  activateTab(name) {
    this.activeTab = name;
    if (this.view && !this.options.panels) this.view.activeTab = name;
    this.shadowRoot.querySelectorAll?.('.dock-tab').forEach(tab => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    this.shadowRoot.querySelectorAll?.('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.dataset.tabPane === name);
    });
    if (name === 'traders') this.view?.ink?.fluid?.invalidateLayout();
    if (name === 'ledger' || name === 'book' || name === 'flow') this.dirty = true;
    else this.canvasDirty = true;
  }

  bindTransportControls() {
    this.el('theme').onchange = () => this.setAttribute('theme', this.el('theme').value);
    this.el('play').onclick = () => {
      this.playback.playing = !this.playing;
      this.playback.clear();
      this.refresh();
    };

    this.el('restart').onclick = () => this.reset();

    this.el('speed').onchange = () => {
      this.playback.speed = Number(this.el('speed').value);
      this.refresh();
    };

    const interval = this.el('chart-interval');
    const press = (attr, value) => this.shadowRoot.querySelectorAll?.(`[data-${attr}]`)
      .forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)));
    this.shadowRoot.querySelectorAll?.('[data-axis]').forEach(button => button.onclick = () => {
      const axis = button.dataset.axis;
      this.view.chartMode = axis;
      this.view.tickOffset = 0;
      interval.innerHTML = intervalOptions(axis);
      interval.value = axis === 'tick' ? this.view.tickSize : this.view.candleSeconds;
      press('axis', axis);
      this.refresh();
    });
    this.shadowRoot.querySelectorAll?.('[data-style]').forEach(button => button.onclick = () => {
      this.view.chartLine = button.dataset.style === 'line';
      press('style', button.dataset.style);
      this.refresh();
    });
    interval.onchange = () => {
      if (this.view.chartMode === 'tick') {
        this.view.tickSize = Number(interval.value);
        this.view.tickOffset = 0;
      } else {
        this.view.candleSeconds = Number(interval.value);
      }
      this.refresh();
    };

    this.el('flow-log').onchange = () => {
      this.view.logCounts = this.el('flow-log').checked;
      this.refresh();
    };

    this.el('field-mode').onchange = () => {
      this.view.fieldMode = this.el('field-mode').value;
      this.refresh();
    };

    this.el('auto-news').onclick = () => {
      this.setRandomNews(!this.randomNews());
    };

    this.el('auto-rate').oninput = () => {
      this.market.setRandomEpisodes(this.randomNews(), Number(this.el('auto-rate').value));
      this.refresh();
    };
  }

  randomNews() {
    return this.el('auto-news').getAttribute('aria-pressed') === 'true';
  }

  renderRandomNews(on) {
    this.el('auto-news').setAttribute('aria-pressed', String(on));
    this.el('auto-news').textContent = `Random: ${on ? 'on' : 'off'}`;
  }

  setRandomNews(on) {
    this.renderRandomNews(on);
    this.market.setRandomEpisodes(on, Number(this.el('auto-rate').value));
    this.refresh();
  }

  bindConfigurationControls() {
    for (const key of CONDITION_KEYS) {
      this.el(key).oninput = () => {
        this.market.configure(this.settings());
        if (key === 'activity') {
          this.market.setArrivalRate(Number(this.el(key).value));
        }
        this.el('preset').value = 'custom';
        this.refresh();
      };
    }

    this.el('preset').onchange = () => {
      const values = PRESETS[this.el('preset').value];
      if (!values) {
        return;
      }
      for (const key of CONDITION_KEYS) {
        this.el(key).value = values[key];
      }
      this.market.configure(this.settings());
      this.market.setArrivalRate(values.activity);
      this.refresh();
    };

    const applyPopulation = value => {
      this.market.setPopulation(value);
      this.el('notice').textContent = '';
      this.refresh();
    };

    this.el('population-input').oninput = () => {
      const value = Number(this.el('population-input').value);
      if (Number.isInteger(value) && value >= ENGINE_CONFIG.POPULATION_MIN && value <= ENGINE_CONFIG.POPULATION_MAX) {
        applyPopulation(value);
      }
    };

    this.el('population-input').onchange = () => {
      const value = Number(this.el('population-input').value);
      try {
        applyPopulation(value);
      } catch (error) {
        this.el('notice').textContent = error.message;
      }
    };

    for (const key of RATIO_KEYS) {
      this.el(`ratio-${key}`).oninput = () => {
        this.market.setRatios(this.ratios());
        this.refresh();
      };
    }

    this.el('seed').onchange = () => this.reset();
    this.el('refresh-ms').addEventListener('input', () => this.refresh());
  }

  bindInformationControls() {
    this.el('news-impact').oninput = () => {
      const raw = this.el('news-impact').value;
      const value = raw === '' ? NaN : Number(raw);
      this.el('news-feedback').textContent =
        Number.isFinite(value) && Math.abs(value) <= ENGINE_CONFIG.MAX_NEWS_IMPACT
          ? ''
          : `Choose an impact within ±${ENGINE_CONFIG.MAX_NEWS_IMPACT}%.`;
      this.refresh();
    };
    this.el('news-duration').oninput = () => this.configure();
    this.bindParamControls();

    this.el('release-news').onclick = () => {
      try {
        const impact = Number(this.el('news-impact').value);
        const duration = Number(this.el('news-duration').value);
        this.market.news(impact, duration);
        this.el('news-feedback').textContent = '';
        this.refresh();
      } catch (error) {
        this.el('news-feedback').textContent = error.message;
      }
    };
  }

  bindParamControls() {
    for (const key of this.episodeKeys) {
      this.input(key).oninput = () => this.configure();
    }
  }

  configure() {
    try {
      this.market.configure(this.settings());
      this.el('news-feedback').textContent = '';
      this.refresh();
    } catch (error) {
      this.el('news-feedback').textContent = error.message;
      updateNews(this, this.market);
    }
  }

  bindCanvasInteractions() {
    this.el('field').onclick = event => {
      const rect = this.el('field').getBoundingClientRect();
      this.view.selected = this.view.hit(event.clientX - rect.left, event.clientY - rect.top);
      this.el('field').focus();
      this.refresh();
    };
    this.el('field').onpointermove = event => {
      const rect = this.el('field').getBoundingClientRect();
      this.view.fieldPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.canvasDirty = true;
    };

    this.el('field').onpointerleave = () => {
      this.view.fieldPointer = null;
      this.canvasDirty = true;
    };

    this.el('flow').onpointermove = event => {
      const rect = this.el('flow').getBoundingClientRect();
      this.view.flowPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.canvasDirty = true;
    };

    this.el('edge').onpointermove = event => {
      const rect = this.el('edge').getBoundingClientRect();
      this.view.edgePointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.canvasDirty = true;
    };

    this.el('edge').onpointerleave = () => {
      this.view.edgePointer = null;
      this.canvasDirty = true;
    };

    this.el('flow').onpointerleave = () => {
      this.view.flowPointer = null;
      this.canvasDirty = true;
    };

    const historyCanvas = this.el('history');
    let dragStart = null;
    const panHistory = deltaX => {
      const rect = historyCanvas.getBoundingClientRect();
      const plotWidth = Math.max(100, rect.width - 60);
      if (this.view.chartMode === 'tick') {
        const slots = Math.floor(plotWidth / 6);
        const stepCandles = Math.round((deltaX / plotWidth) * slots);
        if (stepCandles !== 0) {
          this.view.tickOffset = Math.max(0, this.view.tickOffset + stepCandles);
        }
      } else {
        const deltaMs = (deltaX / plotWidth) * (this.view.historySpanMs || 1800000);
        this.view.historyOffsetMs = Math.max(0, this.view.historyOffsetMs + deltaMs);
      }
      this.refresh();
    };
    const snapLive = () => {
      this.view.historyOffsetMs = 0;
      this.view.tickOffset = 0;
      this.refresh();
    };

    historyCanvas.onpointerdown = event => {
      dragStart = { x: event.clientX, offsetMs: this.view.historyOffsetMs, tickOffset: this.view.tickOffset };
      historyCanvas.setPointerCapture?.(event.pointerId);
    };

    historyCanvas.onpointermove = event => {
      const rect = historyCanvas.getBoundingClientRect();
      this.view.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (dragStart) {
        const dx = event.clientX - dragStart.x;
        const plotWidth = Math.max(100, rect.width - 60);
        if (this.view.chartMode === 'tick') {
          const slots = Math.floor(plotWidth / 6);
          this.view.tickOffset = Math.max(0, dragStart.tickOffset + Math.round((dx / plotWidth) * slots));
        } else {
          this.view.historyOffsetMs = Math.max(0, dragStart.offsetMs + (dx / plotWidth) * (this.view.historySpanMs || 1800000));
        }
        this.refresh();
        return;
      }
      this.canvasDirty = true;
    };

    historyCanvas.onpointerup = event => {
      if (dragStart && Math.abs(event.clientX - dragStart.x) < 4) {
        const x = event.clientX - historyCanvas.getBoundingClientRect().left;
        const marker = this.view.markers.reduce((best, mark) =>
          Math.abs(mark.x - x) < Math.min(12, best ? Math.abs(best.x - x) : Infinity) ? mark : best, null);
        if (marker) {
          this.view.selectedEventId = marker.id;
          this.refresh();
        }
      }
      dragStart = null;
    };
    historyCanvas.onpointercancel = () => { dragStart = null; };

    historyCanvas.onpointerleave = () => {
      dragStart = null;
      this.view.pointer = null;
      historyCanvas.title = '';
      this.canvasDirty = true;
    };

    historyCanvas.onwheel = event => {
      if (event.ctrlKey) return;
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontal && !event.shiftKey) return;
      const delta = horizontal ? event.deltaX : (event.deltaY || event.deltaX);
      if (!delta) return;
      event.preventDefault();
      panHistory(delta * 0.6);
    };

    historyCanvas.ondblclick = snapLive;
  }

  onKey(event) {
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(event.target.tagName)) {
      return;
    }

    const keyActionMap = { ' ': 'play', r: 'restart', n: 'release-news' };
    const normalizedKey = event.key.toLowerCase();

    if (event.target === this.el('field') && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'escape'].includes(normalizedKey)) {
      event.preventDefault();
      const count = this.market.agents.length;
      const forward = normalizedKey === 'arrowright' || normalizedKey === 'arrowdown';
      this.view.selected = normalizedKey === 'escape' ? null :
        ((this.view.selected ?? (forward ? -1 : 0)) + (forward ? 1 : -1) + count) % count;
      this.refresh();
    }

    if (keyActionMap[normalizedKey]) {
      event.preventDefault();
      this.el(keyActionMap[normalizedKey]).click();
    }
  }

  refresh() {
    this.dirty = true;
    this.update();
  }

  update(includeBook = true, includeDiagnostics = true, includeFills = includeBook) {
    const market = this.market;
    if (!market) {
      return;
    }

    const book = market.book();
    const mm = marketMetrics(market, book);
    this.view.book = book;
    updateFigures(this, market, book, mm);
    updateNews(this, market);

    for (const key of CONDITION_KEYS) {
      this.el(`${key}-value`).textContent = `${this.el(key).value}${key === 'activity' ? '/s' : '%'}`;
    }

    const rawRatios = this.ratios();
    const totalRatio = RATIO_KEYS.reduce((s, k) => s + rawRatios[k], 0);
    for (const key of RATIO_KEYS) {
      this.el(`ratio-${key}-value`).textContent = `${Math.round((rawRatios[key] / totalRatio) * 100)}%`;
    }
    this.el('refresh-ms-value').textContent = `${this.el('refresh-ms').value} ms`;

    if (includeBook || includeFills) updateBook(this, market, book, mm, includeBook, includeFills);
    if (includeDiagnostics) updateDiagnostics(this, market);
    const trader = this.view.selected === null ? null : market.agents[this.view.selected];
    if (!trader) this.view.selected = null;
    const latest = market.events.at(-1);
    const informed = Boolean(
      latest && trader && (trader.receivedEpisodeId === latest.id || market.timeMs >= latest.releaseMs)
    );
    this.el('trader-detail').hidden = !trader;
    this.el('trader-detail').textContent = trader
      ? `#${trader.id + 1} ${trader.type} · thinks $${credits(trader.belief)} · ${informed ? 'informed' : 'waiting for news'} · cash $${credits(trader.cash - trader.reservedCash)} · ${trader.shares} shares · ${market.exchange.agentOrderCount(trader.id)} orders`
      : '';
  }

  animate() {
    cancelAnimationFrame(this.frameId);
    this.playback.clear();

    let previousTime = null;
    let lastDomUpdateTime = -Infinity;

    const onFrame = now => {
      if (!this.isConnected) {
        return;
      }

      const deltaMs = previousTime === null ? 0 : Math.max(0, now - previousTime);
      previousTime = now;

      const simulationAdvanced = this.playback.tick(
        now,
        document.hidden,
        chunkMs => this.advanceSafely(chunkMs)
      );

      if (!document.hidden && (simulationAdvanced || this.dirty || this.canvasDirty)) {
        try { this.view.playbackSpeed = this.speed; this.view.draw(this.market, deltaMs, this.playing); }
        catch (error) { this.modelFailure(error); }

        const domInterval = Number(this.el('refresh-ms').value);
        if (this.dirty || (simulationAdvanced && now - lastDomUpdateTime >= domInterval)) {
          const showAll = this.dirty || Boolean(this.options.panels);
          this.update(showAll || this.activeTab === 'book', showAll || this.activeTab === 'ledger', showAll || this.activeTab === 'flow');
          lastDomUpdateTime = now;
        }

        this.dirty = false;
        this.canvasDirty = false;
      }

      this.frameId = requestAnimationFrame(onFrame);
    };

    this.frameId = requestAnimationFrame(onFrame);
  }

  advanceSafely(milliseconds) {
    try {
      this.market.advance(milliseconds);
      if (this.options.emitEvents && typeof CustomEvent !== 'undefined') {
        this.dispatchEvent?.(new CustomEvent('marketsim:tick', { detail: this.metrics, bubbles: true, composed: true }));
      }
    } catch (error) { this.modelFailure(error); }
  }

  modelFailure(error) {
    this.playback.pause();
    this.el('notice').textContent = `Simulation paused: ${error.message}`;
    this.dirty = true;
    this.update();
  }
}

if (!customElements.get('market-ecosystem')) customElements.define('market-ecosystem', MarketEcosystem);
