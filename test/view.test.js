import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../src/sim.js';
import { modelContext } from '../src/model.js';
import { MarketView } from '../src/view.js';
import { levelInk, trackBookInk } from '../src/views/panels.js';
import { model } from './model.js';

const stateOf = m => JSON.stringify({
  timeMs: m.timeMs, price: m.price, value: m.value, tradeCount: m.tradeCount,
  orders: m.orders, trades: m.trades, random: m.random, agents: m.agents
});
function canvas(width, height) {
  const finite = (...args) => { for (const n of args) if (typeof n === 'number') assert.ok(Number.isFinite(n)); };
  const ctx = new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 10 }) : finite, set: () => true });
  return { getBoundingClientRect: () => ({ width, height }), getContext: () => ctx, width: 0, height: 0 };
}

test('a price change within the field domain leaves unchanged beliefs in place', t => {
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  const market = new Market({ model });
  const view = new MarketView(canvas(700, 220), canvas(700, 230));
  view.drawField(market, 0, false);
  const positions = structuredClone(view.positions);
  market.price += 10;
  view.drawField(market, 0, false);
  assert.deepEqual(view.positions, positions);
  view.reset(market);
  assert.equal(view.fieldDomain, null);
});

test('field and history render finite geometry without mutating simulation or random states', t => {
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  const m = new Market({ model }); m.advance(40000); m.news(); m.advance(20000); const before = stateOf(m);
  for (const width of [320, 700, 1100]) {
    const view = new MarketView(canvas(width, 130), canvas(width, 170), canvas(width, 240), canvas(width, 130), canvas(width, 72), canvas(width, 165));
    for (const theme of ['dark', 'light']) {
      view.theme = theme;
      view.draw(m);
      for (const line of [true, false]) for (const mode of ['time', 'tick']) { view.chartLine = line; view.chartMode = mode; view.pointer = { x: width / 2, y: 50 }; view.draw(m); }
      for (const size of [1, 144]) { view.tickSize = size; view.draw(m); }
      assert.ok(view.markers.length > 0);
    }
    const p = view.positions[0]; assert.notEqual(view.hit(p.x, p.y), null);
    assert.equal(view.positions.length, m.agents.length);
  }
  assert.equal(stateOf(m), before);

  const rotatedView = new MarketView(canvas(380, 460), canvas(380, 220));
  const rotMarket = new Market({ model });
  const vAgents = rotMarket.agents.filter(a => a.type === 'value');
  vAgents[0].belief = 9800;
  vAgents[1].belief = 10200;
  rotatedView.drawField(rotMarket, 0, false);
  const avgY = type => {
    const pts = rotatedView.positions.filter(p => rotMarket.agents[p.id].type === type);
    return pts.reduce((s, p) => s + p.y, 0) / pts.length;
  };
  assert.ok(avgY('maker') < avgY('value') && avgY('value') < avgY('trend') && avgY('trend') < avgY('random'));
  assert.ok(rotatedView.positions[vAgents[1].id].x > rotatedView.positions[vAgents[0].id].x);
});

test('separate views keep their model curves cached and refresh them when inputs change', t => {
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  let calls = 0;
  const counted = { ...model, informed: (...args) => { calls++; return model.informed(...args); } };
  const a = new MarketView(canvas(320, 130), canvas(320, 170));
  const b = new MarketView(canvas(320, 130), canvas(320, 170));
  const first = a.episodeCurve(counted, 300, { h: 1 });
  const second = b.episodeCurve(counted, 30, { h: 0.5 });
  assert.equal(calls, 162);
  assert.equal(a.episodeCurve(counted, 300, { h: 1 }), first);
  assert.equal(b.episodeCurve(counted, 30, { h: 0.5 }), second);
  assert.equal(calls, 162);
  assert.notEqual(a.episodeCurve(counted, 300, { h: 0.5 }), first);
  assert.equal(calls, 243);
  assert.equal(a.episodeCurve(counted, 300, { h: 0.5 }, 4).samples.length, 5);
  assert.equal(calls, 248);
  a.episodeCurve({ ...counted }, 300, { h: 0.5 }, 4);
  assert.equal(calls, 253);
});

test('histogram accessibility text updates on fills, reset and market replacement, not animation frames', t => {
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  const flow = canvas(320, 240), labels = [];
  flow.setAttribute = (name, text) => { assert.equal(name, 'aria-label'); labels.push(text); };
  const view = new MarketView(canvas(320, 130), canvas(320, 170), flow);
  const m = new Market({ liquidity: 0 });
  view.drawFlow(m); view.drawFlow(m);
  assert.equal(labels.length, 1); assert.match(labels.at(-1), /since reset: 0/);
  m.submit(0, 'sell', 10000, 5); m.submit(1, 'buy', 10000, 5);
  view.drawFlow(m); view.drawFlow(m);
  assert.equal(labels.length, 2); assert.match(labels.at(-1), /\+5 units: 1/);
  view.reset(m); view.drawFlow(m);
  assert.equal(labels.length, 3);
  const other = new Market({ liquidity: 0 });
  other.submit(0, 'buy', 10000, 3); other.submit(1, 'sell', 10000, 3);
  assert.equal(other.flow.total, m.flow.total);
  view.drawFlow(other); view.drawFlow(other);
  assert.equal(labels.length, 4); assert.match(labels.at(-1), /-3 units: 1/);
});

test('drawFlow scales the informed overlay to expected counts and blooms fresh fills with finite geometry', t => {
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  const m = new Market({ model });
  const view = new MarketView(canvas(320, 130), canvas(320, 170), canvas(320, 240));
  m.news(3, 60); m.advance(30000);
  assert.ok(m.diagnostics.informed.expected > 0);
  for (const logCounts of [true, false]) {
    view.logCounts = logCounts;
    view.drawFlow(m); m.advance(1000); view.ink.clockMs += 16; view.drawFlow(m);
  }
  assert.ok(view.flowInk.born.size > 0);
});

test('state-dependent previews hold one current market snapshot across the entire window', t => {
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  const m = new Market({ model: { ...model, stateDependent: true } });
  const view = new MarketView(canvas(320, 130), canvas(320, 170)), context = modelContext(m), before = stateOf(m);
  const curve = view.episodeCurve(m.model, 30, {}, 4, context);
  assert.equal(view.episodeCurve(m.model, 30, {}, 4, context), curve);
  assert.equal(stateOf(m), before);
  m.advance(250);
  assert.notEqual(view.episodeCurve(m.model, 30, {}, 4, modelContext(m)), curve);
});

test('drawEpisode renders 1-point mid-second episodes and extreme price-response ratios cleanly', t => {
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  const m = new Market({ model });
  m.advance(5200);
  m.news(1, 60);
  const view = new MarketView(canvas(400, 220), canvas(400, 220), null, canvas(320, 230));
  view.drawEpisode(m);
  m.price += 1000;
  m.recordPrice();
  m.advance(1000);
  view.drawEpisode(m);
  assert.ok(view.episodeCurve);
});

test('public release frame does not flash full sweep or drop the history news wash band', t => {
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  const m = new Market({ model });
  m.advance(10000);
  const event = m.news(3, 60);
  m.advance(event.releaseMs - m.timeMs - 500);
  m.submit(0, 'sell', 10000, 2);
  m.submit(1, 'buy', 10000, 2);

  const calls = [];
  const trackingCanvas = (width, height) => {
    const ctx = new Proxy({}, {
      get: (_, key) => (key === 'measureText' ? () => ({ width: 10 }) : (...args) => { calls.push([key, ...args]); }),
      set: () => true
    });
    return { getBoundingClientRect: () => ({ width, height }), getContext: () => ctx, width: 0, height: 0 };
  };

  const view = new MarketView(trackingCanvas(700, 220), trackingCanvas(700, 230));
  view.draw(m, 0, false);
  m.advance(500);
  calls.length = 0;
  view.drawField(m, 0, false);
  assert.equal(view.ink.publicWet, 1);
  assert.equal(view.ink.publicSweepFrac, 0);

  calls.length = 0;
  view.drawHistory(m);
  assert.ok(calls.some(([fn, x, y, w]) => fn === 'fillRect' && w > 5 && y > 20));
});

test('book ink blooms fresh size, wicks removed size, and stays dry across paused advances', t => {
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  const m = new Market({ model, population: 8, seed: 21 });
  for (const order of [...m.orders]) m.cancel(order);
  const view = new MarketView(null, canvas(320, 170), null, null, canvas(320, 150));
  const bid = m.submit(0, 'buy', 9990, 20);
  view.draw(m, 0, false);
  m.submit(1, 'sell', 10010, 30);
  let ink = trackBookInk(view, m);
  assert.equal(levelInk(ink, ink.levels.get(10010)).wet, 0);
  view.ink.clockMs += 16;
  m.submit(1, 'sell', 10010, 10);
  ink = trackBookInk(view, m);
  assert.equal(ink.levels.get(10010).add, 10);
  assert.equal(levelInk(ink, ink.levels.get(10010)).wet, 1);
  view.ink.clockMs += 16;
  m.cancel(bid);
  ink = trackBookInk(view, m);
  assert.deepEqual(ink.wicks.map(w => [w.price, w.side, w.from, w.to]), [[9990, 'buy', 20, 0]]);
  view.ink.clockMs += 2000;
  view.draw(m, 0, false);
  assert.equal(levelInk(view.bookInk, view.bookInk.levels.get(10010)).wet, 0);
  assert.equal(view.bookInk.wicks.length, 0);
});
