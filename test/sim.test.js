import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../src/sim.js';
import { ENGINE_CONFIG } from '../src/model.js';
import { model } from './model.js';
import { refreshMakers } from '../src/strategies.js';
import { TICK_KEEP, TICK_SIZES } from '../src/analytics.js';
const empty = (feeBps = 0) => { const m = new Market({model, population: 8, seed: 21, feeBps }); for (const o of [...m.orders]) m.cancel(o); return m; };
const stateOf = m => JSON.stringify({
  timeMs: m.timeMs, price: m.price, value: m.value, tradeCount: m.tradeCount,
  orders: m.orders, trades: m.trades, random: m.random, agents: m.agents
});

test('price/time priority, partial fills, and refunds at resting prices', () => {
  const m = empty(), before = m.agents[0].cash;
  m.submit(1, 'sell', 9900, 7); m.submit(2, 'sell', 9900, 8);
  const order = m.submit(0, 'buy', 9910, 10);
  assert.equal(order.qty, 0);
  assert.deepEqual(m.trades.map(t => [t.seller, t.qty, t.price]), [[1,7,9900],[2,3,9900]]);
  assert.equal(m.agents[0].cash, before - 99000); assert.equal(m.agents[0].reservedCash, 0);
  assert.equal(m.orders[0].qty, 5); assert.ok(m.assertAccounting());
});
test('reservations prevent overspending and overselling; cancellation releases them', () => {
  const m = empty(), a = m.agents[0];
  const order = m.submit(0, 'buy', 10000, Number.MAX_SAFE_INTEGER);
  assert.equal(order.qty, Math.floor(a.cash / 10000)); assert.equal(m.submit(0, 'buy', 10000, 1), null);
  m.cancel(order); assert.equal(a.reservedCash, 0);
  const ask = m.submit(0, 'sell', 10000, a.shares + 100); assert.equal(ask.qty, a.shares);
  assert.equal(m.submit(0, 'sell', 10000, 1), null); m.cancel(ask); assert.equal(a.reservedShares, 0);
  assert.ok(m.assertAccounting());
});
test('self trades and malformed submissions are rejected', () => {
  const m = empty(); m.submit(0, 'sell', 10000, 5); m.submit(0, 'buy', 10000, 5);
  assert.equal(m.tradeCount, 0);
  for (const args of [[0,'buy',NaN,3], [99,'sell',10000,3], [0,'other',10000,3], [0,'buy',Infinity,3], [0,'buy',10000,-1]]) assert.equal(m.submit(...args), null);
  assert.ok(m.assertAccounting());
});
test('cached book updates after submission, partial fills, cancellation and expiry', () => {
  const m = empty(); assert.equal(m.book(), m.book());
  const a = m.submit(1,'sell',10000,30); assert.equal(m.book().sellDepth,30);
  m.submit(0,'buy',10000,10); assert.equal(m.book().sellDepth,20);
  m.cancel(a); assert.equal(m.book().sellDepth,0);
  m.submit(1,'sell',20000,30); m.configure({liquidity:0}); m.setArrivalRate(1); m.advance(12500);
  assert.ok(m.orders.every(o => o.expiresAtMs > Math.floor(m.timeMs/250)*250)); assert.ok(m.assertAccounting());
});
test('fresh markets start at zero with genuine maker quotes and no invented trades', () => {
  const m = new Market({model}); assert.equal(m.timeMs,0); assert.equal(m.price,10000); assert.equal(m.tradeCount,0);
  assert.ok(m.book().bid < m.book().ask); assert.equal(m.priceHistory.length,1);
});

test('maker refreshes avoid full book rebuilds and best quotes track partial fills and cancellation', () => {
  const m=new Market({model});
  const original=m.exchange.book;
  let rebuilds=0;
  m.exchange.book=function () { rebuilds++; return original.call(this); };
  refreshMakers(m);
  assert.equal(rebuilds,0);
  const {bid,ask}=m.book();
  assert.equal(m.bestBid(),bid); assert.equal(m.bestAsk(),ask);
  for (const order of [...m.orders]) m.cancel(order);
  assert.equal(m.bestBid(),null); assert.equal(m.bestAsk(),null);
  const sell=m.submit(0,'sell',10010,5);
  m.submit(1,'buy',10010,2);
  assert.equal(m.bestAsk(),10010); assert.equal(sell.qty,3);
  m.cancel(sell); assert.equal(m.bestAsk(),null);
  m.submit(0,'buy',9990,5); m.submit(1,'sell',9990,5);
  assert.equal(m.bestBid(),null);
  assert.ok(m.assertAccounting());
});
test('seeded runs and frame partitions produce identical outcomes', () => {
  const a = new Market({model,seed:817}), b = new Market({model,seed:817});
  a.news(3,300); b.news(3,300);
  a.advance(61789); for (const duration of [7,100,682,1000,60000]) b.advance(duration);
  assert.equal(stateOf(a), stateOf(b));
});
test('long runs conserve resources across extreme settings, depleted books and sequential episodes', () => {
  for (const seed of [1,24816,817]) {
    const m = new Market({model,seed});
    for (let i=0;i<12;i++) {
      m.configure({liquidity:i%3===0?0:100,trend:i%2?100:0,uncertainty:i%2?100:0});
      m.news(i%2?5:-5,120); m.advance(120000); assert.ok(m.assertAccounting());
      assert.ok(m.price>0); assert.ok(m.orders.length<=m.agents.length*2);
    }
    assert.ok(m.tradeCount>100); assert.ok(m.priceHistory.length<=1801);
  }
});
test('neutral news consumes no random state and invalid controls are rejected', () => {
  const m = new Market({model}), before=stateOf(m); assert.equal(m.news(0),null); assert.equal(stateOf(m),before);
  assert.throws(()=>m.news(ENGINE_CONFIG.MAX_NEWS_IMPACT + 1)); assert.throws(()=>m.news(1,1)); assert.throws(()=>m.advance(-1)); assert.throws(()=>m.setArrivalRate(0));
  assert.throws(()=>new Market({model,population:1})); assert.throws(()=>new Market({model,seed:-1}));
  assert.throws(()=>m.setPopulation(7)); assert.throws(()=>m.setPopulation(ENGINE_CONFIG.POPULATION_MAX + 1));
});
test('live population and ratio updates preserve accounting without resetting', () => {
  const m = new Market({model, seed: 42});
  m.advance(5000);
  const t0 = m.timeMs;
  m.setPopulation(240);
  assert.equal(m.agents.length, 240);
  assert.equal(m.timeMs, t0);
  assert.ok(m.assertAccounting());

  m.setPopulation(60);
  assert.equal(m.agents.length, 60);
  assert.equal(m.timeMs, t0);
  assert.ok(m.assertAccounting());

  m.setRatios({ maker: 25, value: 25, trend: 25, random: 25 });
  assert.equal(m.agents.filter(a => a.type === 'maker').length, 15);
  assert.equal(m.agents.filter(a => a.type === 'value').length, 15);
  assert.equal(m.agents.filter(a => a.type === 'trend').length, 15);
  assert.equal(m.agents.filter(a => a.type === 'random').length, 15);
  assert.ok(m.assertAccounting());
  m.advance(5000);
  assert.ok(m.assertAccounting());
});
test('random episodes arrive as a Poisson process with random sign, size, and log-normal headstart', () => {
  const m = new Market({model, seed: 7, privateWindowSeconds: 120 });
  m.setRandomEpisodes(true, 30);
  m.advance(3600000); m.advance(3600000);
  assert.ok(m.events.length >= 20 && m.events.length <= 90);
  assert.ok(m.events.every(e => e.impact !== 0 && Math.abs(e.impact) <= ENGINE_CONFIG.MAX_NEWS_IMPACT));
  assert.ok(m.events.some(e => e.impact > 0) && m.events.some(e => e.impact < 0));
  assert.ok(new Set(m.events.map(e => Math.abs(e.impact))).size > 5);
  assert.ok(new Set(m.events.map(e => e.durationSeconds)).size > 2);
});
test('tick candles hold a fixed number of fills and cover every fill', () => {
  const m = new Market({model}); m.advance(120000);
  assert.equal(m.tickCandles.length, TICK_SIZES.length);
  TICK_SIZES.forEach((size, i) => {
    const series = m.tickCandles[i];
    assert.ok(series.length <= TICK_KEEP);
    assert.ok(series.slice(0, -1).every(c => c.trades === size));
    assert.ok(series.every(c => c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close)));
    if (series.length < TICK_KEEP) assert.equal(series.reduce((sum, c) => sum + c.trades, 0), m.tradeCount);
  });
});

test('Gamma-Poisson arrivals produce overdispersed candle trade counts and configure refreshes makers live', () => {
  const m = new Market({ model, seed: 123, population: 800 });
  assert.equal(m.agents.length, 800);
  m.news(35, 2400);
  m.advance(300000);
  const counts = m.candles.map(c => c.trades);
  const mean = counts.reduce((s, x) => s + x, 0) / counts.length;
  const variance = counts.reduce((s, x) => s + (x - mean) ** 2, 0) / counts.length;
  assert.ok(variance > mean * 1.5);

  m.configure({ liquidity: 0 });
  assert.equal(m.agents.filter(a => a.type === 'maker').every(a => !m.orders.some(o => o.agent === a.id)), true);
  m.configure({ liquidity: 100 });
  assert.ok(m.agents.some(a => a.type === 'maker' && m.orders.some(o => o.agent === a.id)));
});

test('taker-to-maker fee transfers integer ticks from aggressor to maker and conserves cash', () => {
  const m = empty(ENGINE_CONFIG.TAKER_FEE_BPS);
  const makerBefore = m.agents[1].cash;
  const takerBefore = m.agents[0].cash;
  m.submit(1, 'sell', 10000, 10);
  m.submit(0, 'buy', 10000, 10);
  const expectedFee = Math.floor((100000 * ENGINE_CONFIG.TAKER_FEE_BPS) / 10000);
  assert.equal(m.agents[0].cash, takerBefore - 100000 - expectedFee);
  assert.equal(m.agents[1].cash, makerBefore + 100000 + expectedFee);
  assert.ok(m.assertAccounting());
});
