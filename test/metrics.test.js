import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../src/sim.js';
import { marketMetrics, strategyMetrics, insiderMetrics, agentMetrics, episodeDiscovery, counterpartyMatrix } from '../src/metrics.js';

test('marketMetrics and strategyMetrics conserve wealth and track imbalance and dislocation', () => {
  const m = new Market({ seed: 42 });
  m.advance(15000);
  const before = JSON.stringify({ price: m.price, tradeCount: m.tradeCount, agents: m.agents });

  const mm = marketMetrics(m);
  assert.ok(Number.isFinite(mm.mid));
  assert.ok(mm.imbalance >= -1 && mm.imbalance <= 1);
  assert.ok(mm.ofi >= -1 && mm.ofi <= 1);
  assert.ok(mm.informedShare >= 0 && mm.informedShare <= 1);

  const sm = strategyMetrics(m);
  assert.deepEqual(Object.keys(sm), ['maker', 'value', 'trend', 'random']);
  const totalPnl = Object.values(sm).reduce((s, r) => s + r.pnl, 0);
  const totalInvDelta = Object.values(sm).reduce((s, r) => s + r.invDelta, 0);
  assert.equal(totalInvDelta, 0);
  assert.equal(totalPnl, m.initialShares * (m.price - 10000));

  const a0 = agentMetrics(m, m.agents[0]);
  assert.equal(a0.pnl, a0.mtmWealth - m.agents[0].initialWealth);
  assert.equal(JSON.stringify({ price: m.price, tradeCount: m.tradeCount, agents: m.agents }), before);
});

test('trading edge is zero-sum and splits early news receivers from the rest', () => {
  const m = new Market({ seed: 7 });
  assert.equal(insiderMetrics(m), null);
  m.advance(5000);
  m.news(5, 60);
  m.advance(30000);
  const sm = Object.values(strategyMetrics(m));
  const { early, late } = insiderMetrics(m);
  assert.ok(early.count > 0 && late.count > 0);
  assert.equal(early.count + late.count, m.agents.length);
  assert.equal(sm.reduce((s, r) => s + r.early, 0), early.count);
  assert.ok(Math.abs(sm.reduce((s, r) => s + r.edge, 0)) < 1e-6);
  assert.ok(Math.abs(early.edge + late.edge) < 1e-6);
});

test('episodeDiscovery tracks pre-release price convergence and counterparty matrix covers recent trades', () => {
  const m = new Market({ seed: 7 });
  m.advance(5000);
  const ev = m.news(5, 60);
  m.advance(30000);

  const disc = episodeDiscovery(m, ev);
  assert.ok(disc);
  assert.ok(disc.trajectory.length >= 2);
  assert.ok(Number.isFinite(disc.discoveryPct));

  const mat = counterpartyMatrix(m);
  assert.equal(mat.types.length, 4);
  const sumTrades = mat.count.flat().reduce((s, n) => s + n, 0);
  assert.equal(sumTrades, m.trades.length);
  assert.ok(mat.maxVolume > 0);
});

test('price response preserves retreats and overshoots for both directions of news', () => {
  for (const direction of [-1, 1]) {
    const event = { startMs: 0, startPrice: 10000, releaseMs: 30000, value: 10000 + direction * 500 };
    const market = {
      timeMs: 20000,
      price: 10000 + direction * 1000,
      priceHistory: [
        { timeMs: 0, price: 10000 },
        { timeMs: 10000, price: 10000 - direction * 500 },
        { timeMs: 20000, price: 10000 + direction * 1000 }
      ]
    };
    const before = JSON.stringify(market);
    const response = episodeDiscovery(market, event);
    assert.equal(Math.abs(response.trajectory[0].ratio), 0);
    assert.deepEqual(response.trajectory.slice(1).map(point => point.ratio), [-1, 2]);
    assert.equal(response.discoveryPct, 200);
    assert.equal(JSON.stringify(market), before);
  }
});

test('news records a fixed baseline even when the first price sample is overwritten or mid-second', () => {
  const market = new Market({ seed: 7 });
  const originalPrice = market.price;
  const event = market.news(5, 60);
  market.price += 50;
  market.recordPrice();
  assert.equal(event.startPrice, originalPrice);
  const response = episodeDiscovery(market, event);
  assert.equal(response.p0, originalPrice);
  assert.equal(response.discoveryPct, 10);
  assert.deepEqual(response.trajectory, [{ seconds: 0, ratio: 0 }, { seconds: 0, ratio: 0.1 }]);

  const midEvent = { startMs: 5250, startPrice: 10000, releaseMs: 35250, value: 10500 };
  const midMarket = {
    timeMs: 6000,
    price: 10100,
    priceHistory: [
      { timeMs: 5000, price: 9900 },
      { timeMs: 6000, price: 10100 }
    ]
  };
  const midResp = episodeDiscovery(midMarket, midEvent);
  assert.deepEqual(midResp.trajectory, [{ seconds: 0, ratio: 0 }, { seconds: 0.75, ratio: 0.2 }]);

  const legacyEvent = { ...event };
  delete legacyEvent.startPrice;
  assert.equal(episodeDiscovery(market, legacyEvent).p0, market.priceHistory[0].price);
});
