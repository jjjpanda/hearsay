import test from 'node:test';
import assert from 'node:assert/strict';
import { Playback, SPEEDS } from '../src/playback.js';
import { Market } from '../src/sim.js';
import { model } from './model.js';

const stateOf = m => JSON.stringify({
  timeMs: m.timeMs, price: m.price, value: m.value, tradeCount: m.tradeCount,
  orders: m.orders, trades: m.trades, random: m.random, agents: m.agents
});

test('playback defaults to 64x and all speeds produce identical states at equal simulated time', () => {
  const results = [];
  for (const speed of SPEEDS) {
    const p = new Playback(), m = new Market({ model });
    assert.equal(p.speed, 64);
    p.speed = speed;
    p.tick(0, false, ms => m.advance(ms), () => 0);
    for (let now = 50; now <= 64000 / speed; now += 50) p.tick(now, false, ms => m.advance(ms), () => 0);
    results.push(stateOf(m));
  }
  for (const result of results) assert.equal(result, results[0]);
});

test('a frame budget retains unfinished work without dropping simulation events', () => {
  const p = new Playback(), m = new Market({ model }), reference = new Market({ model });
  let measure = 0;
  p.tick(0, false, ms => m.advance(ms), () => 0);
  p.tick(100, false, ms => m.advance(ms), () => measure++);
  assert.ok(p.pending > 0);
  assert.ok(m.timeMs < 6400);
  p.tick(100, false, ms => m.advance(ms), () => 0);
  assert.equal(p.pending, 0);
  reference.advance(6400);
  assert.equal(stateOf(m), stateOf(reference));
});

test('pause and hidden-tab transitions discard queued wall time and never catch up', () => {
  const p = new Playback();
  let advanced = 0;
  p.tick(100, false, ms => advanced += ms, () => 0);
  p.tick(200, false, ms => advanced += ms, () => 0);
  assert.equal(advanced, 6400);
  p.tick(10000, true, ms => advanced += ms, () => 0);
  p.tick(20000, false, ms => advanced += ms, () => 0);
  assert.equal(advanced, 6400);
  p.pending = 100;
  p.pause();
  assert.equal(p.pending, 0);
  p.playing = true;
  p.tick(50000, false, ms => advanced += ms, () => 0);
  assert.equal(advanced, 6400);
});
