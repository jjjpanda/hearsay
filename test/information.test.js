import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../src/sim.js';
import { model } from './model.js';
import { updateStrategies, inventoryEstimate } from '../src/strategies.js';

test('receipt timestamps persist through release without replaying old ink', () => {
  const market = new Market({ model, seed: 92 });
  market.news(5, 30);
  market.advance(29750);
  const privateReceipts = new Map(market.agents.filter(a => a.signal).map(a => [a.id, a.signal.receivedMs]));
  assert.ok(privateReceipts.size > 0 && privateReceipts.size < market.agents.length);
  assert.ok([...privateReceipts.values()].every(ms => ms >= 0 && ms <= market.timeMs));
  market.advance(250);
  for (const agent of market.agents) {
    assert.equal(agent.signal.receivedMs, privateReceipts.get(agent.id) ?? 30000);
    assert.equal(agent.signal.public, true);
  }
});

test('reach is a trait of value and trend traders, not a fifth strategy', () => {
  const m = new Market({ model }); assert.equal(new Set(m.agents.map(a => a.type)).size, 4);
  for (const type of ['value', 'trend']) assert.ok(m.agents.filter(a => a.type === type).every(a => a.reach > 0 && a.reach < 1));
  assert.ok(m.agents.filter(a => !['value', 'trend'].includes(a.type)).every(a => a.reach === 1));
});

test('news changes observer value and initial model knowledge immediately, without submitting or executing', () => {
  const a = new Market({ model, seed: 92 });
  const beforePrice = a.price;
  const beforeOrders = JSON.stringify(a.orders);
  const beforeTrades = JSON.stringify(a.trades);
  const beforeFlow = JSON.stringify(a.flow);
  const beforeDiag = JSON.stringify(a.diagnostics);
  const beforeBeliefs = a.agents.map(x => x.belief);
  a.news(5, 300); assert.equal(a.price, beforePrice); assert.equal(a.value, 10500);
  assert.equal(JSON.stringify(a.orders), beforeOrders); assert.equal(JSON.stringify(a.trades), beforeTrades);
  assert.equal(JSON.stringify(a.flow), beforeFlow); assert.equal(JSON.stringify(a.diagnostics), beforeDiag);
  for (const agent of a.agents) {
    assert.equal(agent.knownValue, 10000);
    assert.equal(agent.receivedEpisodeId, agent.reach <= 0.05 + 1e-12 ? 1 : null);
    assert.equal(agent.pendingTarget !== null, agent.reach <= 0.05 + 1e-12);
    assert.equal(agent.belief, beforeBeliefs[agent.id]);
  }
});

test('knowledge spreads along I(t) and becomes public only at the exact release, which alone makes no fill', () => {
  const m = new Market({ model }); m.advance(137); const event = m.news(3, 30);
  const spread = [];
  for (const ms of [7000, 7000, 7000, 7000, 1999]) { m.advance(ms); spread.push(m.newsProgress().known); }
  assert.ok(spread.every((n, i) => !i || n >= spread[i - 1])); assert.ok(spread.at(-1) > spread[0]);
  const I = model.penetration((m.timeMs - event.startMs) / 1000, 30);
  const lastTick = model.penetration((Math.floor(m.timeMs / 250) * 250 - event.startMs) / 1000, 30);
  for (const a of m.agents) assert.equal(a.receivedEpisodeId, a.reach <= lastTick ? event.id : null);
  assert.ok(I < 0.95);
  const p = m.newsProgress(), groups = ['maker', 'value', 'trend', 'random'].map(t => m.newsProgress(event, t));
  assert.equal(groups.reduce((n, g) => n + g.known, 0), p.known); assert.equal(groups[0].known + groups[3].known, 0);
  const price = m.price, count = m.tradeCount, attempts = m.diagnostics.informed.generated;
  m.advance(1); assert.equal(m.episodeId, null); assert.equal(m.price, price); assert.equal(m.tradeCount, count);
  assert.ok(m.agents.every(a => a.receivedEpisodeId === event.id && a.pendingTarget !== null)); assert.equal(m.newsProgress().known, m.agents.length);
  m.advance(10000); assert.equal(m.diagnostics.informed.generated, attempts);
});

test('knowledge boundaries are independent of customer activity and value has no background drift', () => {
  const a = new Market({ model, activity: 1 }), b = new Market({ model, activity: 100 });
  const known = events => events.map(({ arrivals, ...e }) => e);
  assert.deepEqual(known([a.news(2, 300)]), known([b.news(2, 300)])); a.advance(30000); b.advance(30000);
  assert.equal(a.value, b.value); assert.deepEqual(known(a.events), known(b.events));
  assert.deepEqual(a.agents.map(a => a.knownValue), b.agents.map(a => a.knownValue));
});

test('information does not replace the strategy rule', () => {
  const m = new Market({ model }); const value = m.agents.find(a => a.type === 'value'), trend = m.agents.find(a => a.type === 'trend');
  value.knownValue = trend.knownValue = 10500; value.bias = trend.bias = 0; m.configure({ uncertainty: 0 });
  m.timeMs = 1500; updateStrategies(m);
  assert.notEqual(value.belief, trend.belief); assert.ok(value.belief > 10000); assert.ok(trend.belief > 10000);
});

test('value-trader inventory risk shifts the target once instead of compounding each update', () => {
  const m = new Market({ model, uncertainty: 0 }), a = m.agents.find(a => a.type === 'value');
  a.shares = a.initialShares * 1.25; a.knownValue = 10000; a.bias = 0; a.belief = 10000;
  for (let i = 0; i < 100; i++) { m.timeMs += 1500; updateStrategies(m); }
  assert.ok(Math.abs(a.belief - 9990) < 0.001);
});

test('private estimates are delayed, imperfect, and displayed before any execution', () => {
  for (const sign of [1, -1]) {
    const m = new Market({ model, uncertainty: 0, liquidity: 0 });
    const a = m.agents.find(a => a.type === 'value' && a.reach < 0.05);
    a.bias = 0; m.news(sign * 3, 30);
    assert.equal(a.knownValue, 10000);
    assert.equal(a.pendingTarget, 10000 + a.confidence * sign * 300);
    m.timeMs = a.nextResponseMs; updateStrategies(m);
    assert.equal(a.filled, 0);
    assert.equal(a.belief, inventoryEstimate(a));
    assert.ok(Math.abs(a.belief - 10000) > 100);
    assert.equal(a.pendingTarget, null);
  }
});

test('trend forecasts compare quote midpoints without treating execution-side bounce as momentum', () => {
  const a = new Market({ model, uncertainty: 0 }), b = new Market({ model, uncertainty: 0 });
  a.timeMs = b.timeMs = 10000;
  a.quoteHistory = b.quoteHistory = [{ timeMs: 0, mid: 10000 }];
  a.priceHistory = [{ timeMs: 0, price: 9900, value: 10000 }];
  b.priceHistory = [{ timeMs: 0, price: 10100, value: 10000 }];
  updateStrategies(a); updateStrategies(b);
  assert.deepEqual(a.agents.filter(a => a.type === 'trend').map(a => a.belief), b.agents.filter(a => a.type === 'trend').map(a => a.belief));
});

test('one private episode at a time; release and subsequent episode', () => {
  const a = new Market({ model }); a.news(3, 30); a.advance(10000);
  const beforeEvents = a.events.length;
  assert.throws(() => a.news(-2, 120), /private episode is active/);
  assert.equal(a.events.length, beforeEvents);
  a.advance(20000); a.news(-2, 120);
  a.advance(120000);
  assert.ok(a.events.every(e => a.newsProgress(e).known === a.agents.length));
});

test('back-to-back episodes before a trader responds carry prior pending target into the next signal', () => {
  const m = new Market({ model: { id: 'fast', params: [], noise: [1], penetration: () => 1, informed: () => [0] }, uncertainty: 0 });
  const slow = m.agents.find(a => a.responseIntervalMs >= 1000 && a.nextResponseMs >= 1000);
  m.news(10, 30);
  m.advance(30000);
  const firstPublic = slow.pendingTarget;
  assert.ok(firstPublic > 10000);
  slow.nextResponseMs = m.timeMs + 1000;
  m.news(-5, 30);
  assert.equal(slow.receivedEpisodeId, 2);
  assert.equal(slow.signal.prior, firstPublic);
  assert.notEqual(slow.pendingTarget, firstPublic);
});
