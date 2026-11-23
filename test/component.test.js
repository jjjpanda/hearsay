import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInterface } from '../src/template.js';

function element(value = '') {
  const attributes = new Map(), listeners = new Map();
  return {
    value, textContent: '', innerHTML: '', checked: false, hidden: false, style: {}, tagName: 'DIV',
    classList: { toggle() {} },
    setAttribute(k, v) { attributes.set(k, v); },
    getAttribute(k) { return attributes.get(k) ?? null; },
    addEventListener(k, fn) { listeners.set(k, fn); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
    replaceChildren(...children) { this.children = children; },
    append() {}, remove() {}, click() { this.onclick?.({ target: this }); },
    getBoundingClientRect() { return { width: 800, height: 350, left: 0, top: 0 }; },
    getContext() { return null; },
    focus() {}
  };
}

async function setup(t, attributes = { autoplay: 'false' }) {
  const keys = ['HTMLElement', 'customElements', 'requestAnimationFrame', 'cancelAnimationFrame', 'document', 'location', 'matchMedia', 'ResizeObserver', 'Option'];
  const previous = keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  t.after(() => { for (const [k, d] of previous) if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; });
  const frames = new Map();
  let id = 0;
  let renderedMarkup = '';
  class Shadow {
    constructor() { this.elements = new Map(); this.listeners = new Map(); this.link = element(); this.activeElement = null; }
    set innerHTML(markup) {
      renderedMarkup = markup;
      for (const match of markup.matchAll(/<\w+\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const node = element(match[1].match(/\bvalue="([^"]*)"/)?.[1] ?? '');
        node.hidden = /\bhidden\b/.test(match[1]);
        this.elements.set(match[2], node);
      }
    }
    getElementById(id) { return this.elements.get(id); }
    querySelector() { return this.link; }
    addEventListener(k, fn) { this.listeners.set(k, fn); }
    append() {}
  }
  globalThis.HTMLElement = class {
    constructor() { this.attributes = new Map(Object.entries(attributes)); this.isConnected = true; this.style = {}; }
    attachShadow() { this.shadowRoot = new Shadow(); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    setAttribute(k, v) { const old = this.getAttribute(k); this.attributes.set(k, String(v)); this.attributeChangedCallback?.(k, old, String(v)); }
    removeAttribute(k) { const old = this.getAttribute(k); this.attributes.delete(k); this.attributeChangedCallback?.(k, old, null); }
  };
  globalThis.customElements = { define() {}, get() {} };
  globalThis.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.document = { hidden: false, addEventListener() {}, createElement: () => element() };
  globalThis.location = { search: '?autoplay=false' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  const { MarketEcosystem } = await import(`../src/main.js?test=${Math.random()}`);
  const e = new MarketEcosystem();
  e.connectedCallback();
  const draws = [];
  e.view.draw = (...args) => draws.push(args);
  const frame = now => { const callbacks = [...frames.values()]; frames.clear(); for (const fn of callbacks) fn(now); };
  return { e, frame, frames, draws, getMarkup: () => renderedMarkup };
}

test('trader and timeline selections expose live state without advancing or changing the market', async t => {
  const { e } = await setup(t);
  e.setRandomNews(false);
  e.market.news(3, 300);
  e.market.advance(60000);
  e.refresh();
  const before = JSON.stringify(e.market);
  const field = e.el('field');
  e.view.positions = [{ id: 0, x: 100, y: 50 }];
  field.onclick({ clientX: 100, clientY: 50 });
  assert.equal(e.view.selected, 0);
  assert.match(e.el('trader-detail').textContent, /#1.*thinks \$.*cash \$/);
  e.onKey({ target: field, key: 'ArrowRight', preventDefault() {} });
  assert.equal(e.view.selected, 1);
  e.onKey({ target: field, key: 'Escape', preventDefault() {} });
  assert.equal(e.view.selected, null);
  e.view.markers = [{ id: e.market.events[0].id, x: 120 }];
  const history = e.el('history');
  history.onpointerdown({ clientX: 120 });
  history.onpointerup({ clientX: 120 });
  assert.equal(e.view.selectedEventId, e.market.events[0].id);
  assert.equal(JSON.stringify(e.market), before);
});

test('component controls run, pause and reset', async t => {
  const { e, frame, getMarkup } = await setup(t);
  assert.equal(e.market.timeMs, 0);
  assert.equal(e.playing, false);
  assert.equal(e.speed, 64);
  assert.ok(!getMarkup().includes('More simulations'));
  assert.ok(!getMarkup().includes('data-tab="trader"'));
  assert.ok(getMarkup().includes('data-tab="traders"'));
  assert.ok(getMarkup().includes('data-tab="book"'));
  assert.equal(e.activeTab, 'traders');
  assert.equal(e.market.agents.length, 250);
  assert.equal(e.el('save'), undefined);
  assert.equal(e.el('load-model'), undefined);
  assert.equal(e.el('export-trades'), undefined);

  e.el('play').click();
  frame(0); frame(100);
  for (let i = 0; i < 100 && e.playback.pending; i++) frame(100);
  assert.equal(e.market.timeMs, 6400);
  e.el('play').click();
  frame(200);
  assert.equal(e.market.timeMs, 6400);
  assert.equal(e.el('step'), undefined);
  e.el('restart').click();
  assert.equal(e.market.timeMs, 0);
  assert.equal(e.market.tradeCount, 0);
});

test('news inputs and labels stay synchronized across edits, events, and timeline clicks', async t => {
  const { e } = await setup(t);
  assert.equal(e.el('news-impact').value, '2');
  assert.equal(e.el('news-impact-value').textContent, '+2.0%');
  assert.equal(e.el('news-duration').value, '300');
  assert.equal(e.el('news-duration-value').textContent, '5 min');

  e.el('release-news').click();
  assert.equal(e.market.events.length, 1);
  assert.equal(e.el('news-feedback').textContent, '');

  e.el('news-impact').value = '4.5';
  e.el('news-impact').oninput();
  assert.equal(e.el('news-impact-value').textContent, '+4.5%');
  assert.equal(e.el('news-impact').value, '4.5');

  e.el('news-duration').value = '90';
  e.el('news-duration').oninput();
  assert.equal(e.el('news-duration-value').textContent, '1.5 min');
  assert.equal(e.el('news-duration').value, '90');

  e.el('news-impact').value = '0';
  e.el('news-impact').oninput();
  assert.equal(e.el('news-impact-value').textContent, '0.0%');
  assert.equal(e.el('release-news').disabled, true);

  e.el('news-impact').value = '60';
  e.el('news-impact').oninput();
  assert.match(e.el('news-feedback').textContent, /±50%/);
  assert.equal(e.el('release-news').disabled, true);

  e.market.advance(300000);
  e.market.news(-3.2, 180);
  e.refresh();
  assert.equal(e.el('news-impact').value, '-3.2');
  assert.equal(e.el('news-impact-value').textContent, '-3.2%');
  assert.equal(e.el('news-duration').value, '180');
  assert.equal(e.el('news-duration-value').textContent, '3 min');

  e.market.advance(180000);
  e.shadowRoot.activeElement = e.el('news-impact');
  e.el('news-impact').value = '7';
  e.market.news(1.5, 60);
  e.refresh();
  assert.equal(e.el('news-impact').value, '7');
  assert.equal(e.el('news-impact-value').textContent, '+7.0%');
  assert.equal(e.el('news-duration').value, '60');
  assert.equal(e.el('news-duration-value').textContent, '1 min');
  e.shadowRoot.activeElement = null;

  const beforeClick = JSON.stringify(e.market);
  e.view.markers = [{ id: e.market.events[0].id, x: 100 }];
  e.el('history').onpointerdown({ clientX: 100 });
  e.el('history').onpointerup({ clientX: 100 });
  assert.equal(e.el('news-impact').value, '2');
  assert.equal(e.el('news-impact-value').textContent, '+2.0%');
  assert.equal(e.el('news-duration').value, '300');
  assert.equal(e.el('news-duration-value').textContent, '5 min');
  assert.equal(JSON.stringify(e.market), beforeClick);

  e.el('preset').value = 'thin';
  e.el('preset').onchange();
  assert.equal(e.market.settings.liquidity, 20);
  assert.equal(e.market.clock.rate, 15);
  e.el('restart').click();
  assert.equal(e.market.events.length, 0);
  assert.equal(e.view.selectedEventId, null);
});

test('paused views skip repeat rendering and reconnection keeps one RAF chain', async t => {
  const { e, frame, frames, draws } = await setup(t);
  frame(0); assert.equal(draws.length, 1);
  frame(16); frame(32); assert.equal(draws.length, 1);
  e.dirty = true; frame(48); assert.equal(draws.length, 2);
  e.disconnectedCallback(); assert.equal(frames.size, 0);
  e.connectedCallback(); assert.equal(frames.size, 1);
  frame(1000); assert.equal(frames.size, 1); assert.equal(e.market.timeMs, 0);
  e.disconnectedCallback();
});

test('attributes configure each instance independently and population/ratios update live without resetting', async t => {
  const { e } = await setup(t, { autoplay: 'false', seed: '7', population: '120', preset: 'thin', theme: 'light', speed: '4', width: '800', height: '450' });
  assert.equal(e.market.initialSeed, 7);
  assert.equal(e.market.agents.length, 120);
  assert.equal(e.market.settings.liquidity, 20);
  assert.equal(e.market.clock.rate, 15);
  assert.equal(e.view.theme, 'light');
  assert.equal(e.speed, 4);
  assert.equal(e.style.width, 'min(100%, 800px)');
  assert.equal(e.style.height, '450px');

  e.market.advance(1000);
  const t0 = e.market.timeMs;
  for (const [key, value] of Object.entries({ theme: 'dark', transparent: 'true', embed: 'false', width: '600', height: '400', speed: '16' })) {
    e.setAttribute(key, value);
  }
  assert.equal(e.market.timeMs, t0);
  assert.equal(e.speed, 16);
  e.setAttribute('speed', '256');
  assert.equal(e.speed, 256);
  assert.equal(e.view.theme, 'dark');

  e.setAttribute('population', '200');
  assert.equal(e.market.agents.length, 200);
  assert.equal(e.market.timeMs, t0);
  assert.equal(e.market.assertAccounting(), true);

  e.el('population-input').value = '80';
  e.el('population-input').onchange();
  assert.equal(e.market.agents.length, 80);
  assert.equal(e.market.timeMs, t0);
  assert.equal(e.market.assertAccounting(), true);

  e.el('ratio-maker').value = '50';
  e.el('ratio-value').value = '50';
  e.el('ratio-trend').value = '0';
  e.el('ratio-random').value = '0';
  e.el('ratio-maker').oninput();
  assert.equal(e.market.timeMs, t0);
  assert.equal(e.market.agents.filter(a => a.type === 'maker').length, 40);
  assert.equal(e.market.agents.filter(a => a.type === 'value').length, 40);
  assert.equal(e.market.assertAccounting(), true);

  e.setAttribute('preset', 'trend');
  assert.equal(e.market.clock.rate, 45);
  assert.equal(e.market.timeMs, t0);
  e.setAttribute('autoplay', 'true');
  assert.equal(e.playing, true);
  e.setAttribute('autoplay', 'false');
  assert.equal(e.playing, false);
  e.setAttribute('seed', '9');
  assert.equal(e.market.initialSeed, 9);
  assert.equal(e.market.timeMs, 0);
  e.removeAttribute('height');
  assert.equal(e.style.height, '');
  assert.equal(e.style.overflowY, '');
});

test('numeric controls explain invalid edits and keep labels consistent', async t => {
  const { e } = await setup(t);
  const previous = e.market.settings.privateWindowSeconds;
  e.el('news-duration').value = '';
  e.el('news-duration').oninput();
  assert.equal(e.market.settings.privateWindowSeconds, previous);
  assert.equal(e.el('news-duration-value').textContent, '—');
  assert.match(e.el('news-feedback').textContent, /privateWindowSeconds/);
});

test('random news defaults to on, population updates on input, and model tab explains the math', async t => {
  const { e } = await setup(t);
  assert.equal(e.el('auto-news').getAttribute('aria-pressed'), 'true');
  assert.equal(e.el('auto-news').textContent, 'Random: on');
  assert.equal(e.market.auto.enabled, true);

  e.el('population-input').value = '5000';
  e.el('population-input').oninput();
  assert.equal(e.market.agents.length, 5000);

  const markup = renderInterface(e.model);
  assert.doesNotMatch(markup, /How this market works|<footer/i);
  assert.match(markup, /data-tab="model"/);
  assert.match(markup, /How the simulation works/);
  assert.match(markup, /The news goes public/);
  assert.doesNotMatch(markup, /viz-num/);
  assert.match(markup, /class="viz-tag">news<\/text>[\s\S]*class="viz-tag">public<\/text>/);
  assert.match(markup, /λ\(t\) ∝ I\(t\) × burst\(t\)/);

  e.market.advance(60000);
  e.el('history').onwheel({ deltaY: 500, deltaX: 0, preventDefault() {} });
  assert.equal(e.view.historyOffsetMs, 0);
  e.el('history').onwheel({ ctrlKey: true, deltaY: 500, deltaX: 0, preventDefault() {} });
  assert.equal(e.view.historyOffsetMs, 0);
  e.el('history').onwheel({ shiftKey: true, deltaY: 500, deltaX: 0, preventDefault() {} });
  assert.ok(e.view.historyOffsetMs > 0);
  e.el('history').ondblclick();
  e.el('history').onwheel({ deltaX: 500, deltaY: 0, preventDefault() {} });
  assert.ok(e.view.historyOffsetMs > 0);
  e.el('history').ondblclick();
  assert.equal(e.view.historyOffsetMs, 0);
  assert.equal(e.view.tickOffset, 0);
  assert.equal(e.el('history-live'), undefined);

  e.dirty = false;
  e.canvasDirty = false;
  e.el('field').onpointermove({ clientX: 50, clientY: 50 });
  assert.equal(e.canvasDirty, true);
  assert.equal(e.dirty, false);

  e.onKey({ target: e.el('market'), key: 'n', preventDefault() {} });
  assert.equal(e.market.events.length, 1);

  const embed = await setup(t, { autoplay: 'false', embed: 'true' });
  assert.equal(embed.e.view.embed, true);
  delete embed.e.view.draw;
  embed.e.market.submit(0, 'sell', 10000, 4);
  embed.e.market.submit(1, 'buy', 10000, 4);
  const drawn = {};
  const glyphs = [];
  const mockCtx = new Proxy({}, {
    get: (_, key) => (key === 'measureText' ? () => ({ width: 10 }) : key === 'fillRect' ? (...args) => glyphs.push(args) : () => {}),
    set: () => true
  });
  for (const id of ['history', 'episode', 'matrix', 'field', 'book-depth', 'flow', 'edge']) {
    embed.e.el(id).getContext = () => {
      drawn[id] = (drawn[id] ?? 0) + 1;
      return mockCtx;
    };
  }
  embed.e.view.draw(embed.e.market, 0, false);
  assert.deepEqual(drawn, { history: 1 });
  assert.ok(glyphs.length > 0);
  embed.e.update();
  assert.match(embed.e.el('book-levels').innerHTML, /--depth:\d+%;--wet:0\.00;--cut:0\.00/);
});
