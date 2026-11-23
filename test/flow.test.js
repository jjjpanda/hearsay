import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../src/sim.js';
import { model } from './model.js';
import { informedRates, poisson } from '../src/flow.js';
import { DEFAULTS, NEUTRAL, createModel, logisticShare } from '../src/model.js';
import { attemptCustomer, inventoryEstimate } from '../src/strategies.js';
import { flowSeries } from '../src/analytics.js';

const clear = m => { for (const o of [...m.orders]) m.cancel(o); };
const empty = () => { const m = new Market({ model, liquidity: 0, uncertainty: 0 }); clear(m); return m; };
const near = (a, b, tolerance = 1e-12) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);
const stateOf = m => JSON.stringify({
  timeMs: m.timeMs, price: m.price, value: m.value, tradeCount: m.tradeCount,
  orders: m.orders, trades: m.trades, random: m.random, agents: m.agents
});

test('built-in model gates informed flow to the private window', () => {
  const e = new Market().news();
  for (const ms of [-1, 300000, 300001]) assert.equal(informedRates(NEUTRAL, ms, e, 40), null);
  assert.equal(informedRates(NEUTRAL, 1000, null, 40), null);
  near(informedRates(NEUTRAL, 1000, e, 40).reduce((sum, rate) => sum + rate, 0), 40 * logisticShare(1, 300));
  assert.equal(informedRates({ ...NEUTRAL, informed: () => null }, 1000, e, 40), null);
  assert.deepEqual(e.params, {});
});

test('model params become validated settings and are stored on each episode', () => {
  assert.equal(new Market({ model }).settings.h, 1);
  assert.throws(() => new Market({ model, h: 3 }));
  const m = new Market({ model, h: 0.5 }); const e = m.news(3, 30);
  assert.deepEqual(e.params, { h: 0.5 }); near(informedRates(model, 1000, e, 40)[0], 40 * model.informed(1, 30, { h: 0.5 })[0]);
});

test('the engine validates function models and their informed output', () => {
  assert.equal(createModel(NEUTRAL), NEUTRAL);
  assert.throws(() => createModel({ format: 'marketsim-formula', version: 1 }), /Only the built-in flow model/);
  assert.throws(() => new Market({ model: { ...model, noise: [NaN] } }), /Only the built-in flow model/);
  for (const out of [[NaN], [-1], Array(501).fill(1)]) {
    const bad = { ...model, evaluate: undefined, informed: () => out };
    assert.throws(() => informedRates(createModel(bad), 1000, new Market().news(), 40), /invalid informed rates/);
  }
});

test('Poisson draws are seeded, consume no state at zero, and recover mean and variance', () => {
  const a = { seed: 123 }, b = { seed: 123 }, untouched = { ...a };
  assert.equal(poisson(a, 0), 0); assert.deepEqual(a, untouched);
  for (const mean of [0.01, 0.5, 3, 20, 70]) {
    const draws = Array.from({ length: 12000 }, () => poisson(a, mean));
    assert.deepEqual(draws, Array.from({ length: 12000 }, () => poisson(b, mean)));
    const average = draws.reduce((s, n) => s + n, 0) / draws.length;
    const variance = draws.reduce((s, n) => s + (n - average) ** 2, 0) / draws.length;
    assert.ok(Math.abs(average - mean) < Math.max(0.01, mean * 0.05));
    assert.ok(Math.abs(variance - mean) < Math.max(0.01, mean * 0.08));
  }
  assert.throws(() => poisson(a, -1)); assert.throws(() => poisson(a, Infinity));
});

test('informed counts use their own stream and retain identical sizes across opposite shocks', () => {
  const positive = new Market({ model, seed: 81 }), negative = new Market({ model, seed: 81 });
  positive.news(3, 30); negative.news(-3, 30);
  positive.advance(30000); negative.advance(30000);
  const p = positive.diagnostics.informed, n = negative.diagnostics.informed;
  assert.ok(p.generated > 0); assert.equal(p.generated, n.generated); assert.deepEqual(p.sizes, n.sizes);
  assert.equal(p.buys, p.generated); assert.equal(n.sells, n.generated);
  assert.deepEqual(positive.informed, negative.informed);
  const zero = new Market({ model, seed: 81 }), control = new Market({ model, seed: 81 }); zero.news(0, 30);
  zero.advance(30000); control.advance(30000); assert.equal(stateOf(zero), stateOf(control));
  assert.equal(zero.diagnostics.informed.generated, 0); assert.equal(zero.expectedAttempts().informed, 0);
});

test('informed flow and integrated expectations are independent of frame partitions', () => {
  const a = new Market({ model, seed: 91 }), b = new Market({ model, seed: 91 });
  a.advance(137); b.advance(137); a.news(3, 30); b.news(3, 30);
  a.advance(20111); for (const dt of [1, 12, 248, 600, 7777, 11473]) b.advance(dt);
  assert.equal(stateOf(a), stateOf(b));
  a.setArrivalRate(80); a.advance(20000);
  near(a.expectedAttempts().baseline, DEFAULTS.activity * 20.248 + 80 * 20);
  const expected = a.expectedAttempts().informed; a.advance(1000); assert.equal(a.expectedAttempts().informed, expected);
});

test('only informed value/trend traders receive informed attempts; absent receivers remain observable', () => {
  const routed = new Market({ model }), unrouted = new Market({ model });
  for (const a of unrouted.agents) a.reach = 1;
  routed.news(3, 30); unrouted.news(3, 30); routed.advance(29999); unrouted.advance(29999);
  assert.equal(routed.diagnostics.informed.generated, unrouted.diagnostics.informed.generated);
  assert.ok(unrouted.diagnostics.informed.generated > 0);
  assert.equal(unrouted.diagnostics.informed.unrouted, unrouted.diagnostics.informed.generated);
  assert.equal(unrouted.diagnostics.submitted.informed, 0); assert.equal(unrouted.flow.byOrigin.informed, 0);
  const fills = routed.trades.filter(t => t.origin === 'informed'); assert.ok(fills.length > 0);
  for (const fill of fills) {
    const buyer = routed.agents[fill.buyer];
    assert.equal(fill.side, 'buy'); assert.ok(['value', 'trend'].includes(buyer.type)); assert.ok(buyer.reach < 0.95);
  }
});

test('fills record the best quotes seen before the incoming order matched', () => {
  const m = empty();
  m.submit(0, 'sell', 10010, 7); m.submit(1, 'sell', 10020, 9); m.submit(2, 'buy', 9990, 4);
  m.submit(3, 'buy', 10020, 10);
  assert.deepEqual(m.trades.map(t => [t.qty, t.price, t.bid, t.bidSize, t.ask, t.askSize]), [[7, 10010, 9990, 4, 10010, 7], [3, 10020, 9990, 4, 10010, 7]]);
  clear(m); m.submit(0, 'buy', 10000, 5); m.submit(1, 'sell', 10000, 5);
  assert.deepEqual([m.trades.at(-1).ask, m.trades.at(-1).askSize], [null, null]);
});

test('value seekers reject quotes without a two-tick edge, including inventory adjustment', () => {
  for (const side of ['buy', 'sell']) {
    const m = empty(), a = m.agents.find(a => a.type === 'value'); a.bias = 0;
    a.belief = side === 'buy' ? 10100 : 9900;
    m.submit(0, side === 'buy' ? 'sell' : 'buy', side === 'buy' ? 9999 : 10001, 20);
    assert.equal(attemptCustomer(m, a, 10, side), null); assert.equal(m.tradeCount, 0);
    assert.match(a.lastAction, /two ticks/);
    a.shares += Math.round(a.initialShares * 0.25);
    assert.ok(inventoryEstimate(a) < 10000);
  }
});

test('customer sweeps stop ten ticks from the best quote and rest the actual remainder', () => {
  for (const side of ['buy', 'sell']) {
    const m = empty(), a = m.agents.find(a => a.type === 'value'); a.bias = 0;
    a.knownValue = a.belief = side === 'buy' ? 10500 : 9500;
    const direction = side === 'buy' ? 1 : -1;
    [0, 5, 10, 11].forEach((offset, i) => m.submit(i, side === 'buy' ? 'sell' : 'buy', 10000 + direction * offset, [7, 8, 9, 100][i]));
    const order = attemptCustomer(m, a, 50, side);
    assert.equal(order.price, 10000 + direction * 10); assert.equal(order.qty, 26);
    assert.deepEqual(m.trades.map(t => t.qty), [7, 8, 9]);
    assert.deepEqual(flowSeries(m.flow), direction === 1 ? [{ size: 7, count: 1 }, { size: 8, count: 1 }, { size: 9, count: 1 }] : [{ size: -9, count: 1 }, { size: -8, count: 1 }, { size: -7, count: 1 }]);
    assert.ok(m.trades.every(t => t.aggressorOrderId === order.id));
    assert.equal(m.orders.find(o => o.price === 10000 + direction * 11).qty, 100);
    assert.ok(m.assertAccounting());
  }
});

test('value limits can stop a sweep before ten ticks; empty books accept bounded offers', () => {
  for (const side of ['buy', 'sell']) {
    const m = empty(), a = m.agents.find(a => a.type === 'value'); a.bias = 0;
    a.knownValue = a.belief = side === 'buy' ? 10008 : 9992;
    const direction = side === 'buy' ? 1 : -1;
    m.submit(0, side === 'buy' ? 'sell' : 'buy', 10000, 7);
    m.submit(1, side === 'buy' ? 'sell' : 'buy', 10000 + direction * 8, 8);
    const order = attemptCustomer(m, a, 25, side);
    assert.equal(order.price, 10000 + direction * 6); assert.equal(order.qty, 18); assert.equal(m.tradeCount, 1);
    clear(m);
    const resting = attemptCustomer(m, a, 25, side);
    assert.ok(resting); assert.equal(resting.qty, 25);
    assert.equal(resting.price, side === 'buy' ? Math.floor(inventoryEstimate(a) - 2) : Math.ceil(inventoryEstimate(a) + 2));
    assert.ok(m.assertAccounting());
  }
});

test('informed trend traders retain momentum, obey value bounds and can decline informed attempts', () => {
  const m = empty(), a = m.agents.find(a => a.type === 'trend' && a.reach < 0.05); a.bias = 0;
  m.news(3, 30); a.belief = 9900;
  assert.equal(attemptCustomer(m, a, 10, 'buy', 'informed', 1), null); assert.match(a.lastAction, /momentum/);
  m.value = a.knownValue = m.events[0].value = 10000; a.belief = 11000;
  m.submit(0, 'sell', 9999, 10);
  assert.equal(attemptCustomer(m, a, 10, 'buy', 'informed', 1), null); assert.match(a.lastAction, /two ticks/);
  clear(m); m.submit(0, 'sell', 9997, 5);
  const patient = attemptCustomer(m, a, 10, 'buy', 'informed', 1);
  assert.equal(patient.price, 9996); assert.equal(m.trades.length, 0);
  m.events[0].startMs = m.timeMs - 1e9;
  const order = attemptCustomer(m, a, 10, 'buy', 'informed', 1);
  assert.equal(order.price, 9998); assert.equal(order.qty, 5);
  assert.equal(m.trades[0].origin, 'informed'); assert.equal(m.trades[0].episodeId, 1);
  clear(m); a.cash = 0;
  assert.equal(attemptCustomer(m, a, 10, 'buy', 'informed', 1), null); assert.match(a.lastAction, /cash/);
});

test('large private alpha immediately sweeps both sides, within the value and ten-tick limits', () => {
  for (const type of ['value', 'trend']) {
    for (const sign of [1, -1]) {
      const m = empty(), a = m.agents.find(a => a.type === type && a.reach < 0.05);
      const side = sign === 1 ? 'buy' : 'sell', opposite = sign === 1 ? 'sell' : 'buy';
      a.bias = 0; a.confidence = 1; m.configure({ uncertainty: 0 });
      m.news(sign * 3, 30);
      a.knownValue = a.pendingTarget; a.pendingTarget = null;
      a.belief = 10000 + sign;
      m.submit(0, side, 10000 - sign * 6, 10);
      [0, 5, 10, 11].forEach((offset, i) => m.submit(i + 1, opposite, 10000 + sign * (6 + offset), [7, 8, 9, 100][i]));
      const order = attemptCustomer(m, a, 50, side, 'informed', 1);
      assert.equal(m.timeMs, 0);
      assert.equal(order.price, 10000 + sign * 16);
      assert.equal(order.qty, 26);
      assert.deepEqual(m.trades.map(t => t.qty), [7, 8, 9]);
      assert.ok(sign * (inventoryEstimate(a) - order.price) >= 2);
      assert.ok(m.trades.every(t => t.side === side && t.origin === 'informed'));
      assert.ok(m.assertAccounting());
    }
  }
});

test('patient informed quotes exclude their own orders and declined attempts preserve them', () => {
  for (const sign of [1, -1]) {
    const m = empty(), a = m.agents.find(a => a.type === 'value' && a.reach < 0.05);
    const side = sign === 1 ? 'buy' : 'sell', opposite = sign === 1 ? 'sell' : 'buy';
    m.news(sign * 3, 30); a.bias = 0;
    m.value = m.events[0].value = a.knownValue = 10000;
    m.submit(0, opposite, 10000 - sign * 3, 20);
    m.submit(1, side, 10000 - sign * 15, 20);
    const old = m.submit(a.id, side, 10000 - sign * 5, 20);
    const patient = attemptCustomer(m, a, 10, side, 'informed', 1);
    assert.equal(patient.price, 10000 - sign * 14);
    assert.ok(!m.orders.includes(old));
    clear(m);
    const keep = m.submit(a.id, side, 10000 - sign * 15, 20);
    m.submit(0, opposite, 10000 - sign, 20);
    assert.equal(attemptCustomer(m, a, 10, side, 'informed', 1), null);
    assert.ok(m.orders.includes(keep));
    assert.ok(m.assertAccounting());
  }
});

test('default news generates informed executions and discovers price', () => {
  const markets = [3, -3].map(impact => {
    const m = new Market({ seed: 81 }); m.news(impact, 30); return m;
  });
  for (const [i, m] of markets.entries()) {
    m.advance(29999);
    assert.ok(m.diagnostics.informed.generated > 0);
    assert.ok(m.flow.byOrigin.informed > 0);
    assert.ok(i === 0 ? m.price > 10000 : m.price < 10000);
    assert.ok(m.assertAccounting());
  }
  assert.deepEqual(markets[0].diagnostics.informed.sizes, markets[1].diagnostics.informed.sizes);
});

test('partial fills retain both originating IDs and informed provenance after public release', () => {
  const m = new Market({ model }); m.advance(137); m.news(3, 30); m.advance(29999); clear(m);
  const a = m.agents.find(a => a.type === 'value'), seller = m.agents.find(a => a.type === 'random');
  const resting = m.submit(a.id, 'buy', 10030, 10, { origin: 'informed', episodeId: 1 });
  m.advance(1);
  const sell = m.submit(seller.id, 'sell', 10020, 4);
  const fill = m.trades.at(-1);
  assert.equal(fill.qty, 4); assert.equal(fill.price, 10030); assert.equal(fill.side, 'sell');
  assert.equal(fill.aggressorOrderId, sell.id); assert.equal(fill.restingOrderId, resting.id);
  assert.equal(fill.buyerOrderId, resting.id); assert.equal(fill.sellerOrderId, sell.id);
  assert.equal(fill.origin, 'baseline'); assert.equal(fill.restingOrigin, 'informed'); assert.equal(fill.restingEpisodeId, 1);
  assert.equal(resting.qty, 6); assert.equal(resting.origin, 'informed'); assert.ok(m.assertAccounting());
});

test('signed histogram counts each partial execution once and outlives the recent-trade buffer', () => {
  const m = empty();
  for (let i = 0; i < 610; i++) {
    const side = i % 2 ? 'buy' : 'sell';
    m.submit(0, side === 'buy' ? 'sell' : 'buy', 10000, 1);
    m.submit(1, side, 10000, 1);
  }
  assert.equal(m.trades.length, 500); assert.equal(m.tradeCount, 610);
  assert.equal(m.flow.total, 610); assert.deepEqual(m.flow.counts, { '1': 305, '-1': 305 });
  assert.ok(m.assertAccounting());
});
