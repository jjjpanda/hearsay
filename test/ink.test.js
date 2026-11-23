import test from 'node:test';
import assert from 'node:assert/strict';
import { InkFluid, InkPlayback, drawAcrylicDab, drawInkWashBand, drawPublicSweep, drawWatercolorBloom } from '../src/views/ink.js';

const market = (timeMs = 0) => ({
  timeMs,
  events: [{ id: 1, releaseMs: 300000 }],
  agents: [{ id: 0, receivedEpisodeId: 1, signal: { receivedMs: 0 } }]
});

test('ink remains readable for the same screen duration at 1x and 64x', () => {
  const views = [1, 64].map(speed => ({ speed, market: market(), ink: new InkPlayback() }));
  for (const view of views) {
    view.ink.update(view.market, 0, false);
    for (let frame = 0; frame < 60; frame++) {
      view.market.timeMs += 16 * view.speed;
      view.ink.update(view.market, 16, true);
    }
    assert.ok(view.ink.traderWet(0) > 0.5);
  }
  assert.equal(views[0].ink.traderWet(0), views[1].ink.traderWet(0));
});

test('pause freezes ink, and changing speed does not restart a dry receipt', () => {
  const m = market(), ink = new InkPlayback();
  ink.update(m);
  for (let i = 0; i < 40; i++) { m.timeMs += 1024; ink.update(m, 16, true); }
  const wet = ink.traderWet(0);
  ink.update(m, 10000, false);
  assert.equal(ink.traderWet(0), wet);
  for (let i = 0; i < 120; i++) { m.timeMs += 16; ink.update(m, 16, true); }
  assert.equal(ink.traderWet(0), 0);
  m.timeMs += 1024; ink.update(m, 16, true);
  assert.equal(ink.traderWet(0), 0);
});

test('old receipts do not bloom on restore or paused bulk advance; public release has its own pulse', () => {
  const restored = market(200000), ink = new InkPlayback();
  const before = JSON.stringify(restored);
  ink.update(restored);
  assert.equal(ink.traderWet(0), 0);
  assert.equal(JSON.stringify(restored), before);
  restored.timeMs = 300000;
  ink.update(restored, 0, false);
  assert.equal(ink.publicWet, 1);
  assert.equal(ink.traderWet(0), 0);
  restored.agents.push({ id: 1, receivedEpisodeId: 1, signal: { receivedMs: 300000 } });
  ink.update(restored, 0, false);
  assert.equal(ink.traderWet(1), 0);
  const paused = market(), other = new InkPlayback();
  paused.agents = []; other.update(paused);
  paused.timeMs = 200000;
  paused.agents = [{ id: 0, receivedEpisodeId: 1, signal: { receivedMs: 1000 } }];
  other.update(paused, 0, false);
  assert.equal(other.traderWet(0), 0);
});

test('reduced motion halts fluid motion and theme changes invalidate cached fluid pixels', () => {
  const m = market(), ink = new InkPlayback();
  ink.fluid.ensureSize(120, 60);
  ink.fluid.injectDroplet(40, 30, 8, 0.7, 1.5, 2.0);
  assert.equal(ink.fluid.active, true);
  m.timeMs += 16;
  ink.update(m, 16, true, true);
  assert.equal(ink.fluid.active, false);

  ink.fluid.injectMiddleSwell(60, 0, 60, 0.25, 3.17, 'news', false);
  assert.equal(ink.fluid.active, false);

  const fluid = new InkFluid();
  fluid.ensureSize(60, 30);
  fluid.stampDryResidue(30, 15, 6, 0.5, 1.0);
  const data = new Uint8ClampedArray(fluid.gw * fluid.gh * 4);
  fluid.imgData = { data };
  fluid.offCtx = { putImageData() {} };
  fluid.offscreen = {};
  const ctx = { save() {}, restore() {}, drawImage() {} };

  fluid.render(ctx, 0, 0, 60, 30, true);
  const lightSnapshot = Uint8ClampedArray.from(data);
  fluid.render(ctx, 0, 0, 60, 30, false);
  assert.notDeepEqual(data, lightSnapshot);
});

test('middle swell stays localized, gravity pulls wet pigment down, decay clears dry paint, and dark mode is a translucent wash with tide lines', () => {
  const fluid = new InkFluid();
  fluid.ensureSize(200, 100);
  fluid.injectMiddleSwell(100, 0, 100, 0.8, 1.2, 'news', true);
  assert.equal(fluid.active, true);
  assert.equal(fluid.hasPaint, true);
  const midY = Math.floor(fluid.gh / 2);
  const midX = Math.floor(fluid.gw / 2);
  assert.ok(fluid.pigN[midY * fluid.gw + midX] > 0);
  assert.equal(fluid.pigN[midY * fluid.gw + 2], 0);
  assert.equal(fluid.pigN[midY * fluid.gw + fluid.gw - 3], 0);

  const dropFluid = new InkFluid();
  dropFluid.ensureSize(120, 120);
  dropFluid.injectDroplet(60, 30, 12, 0.9, 1.0, 2.2, 'up');
  const centerY = f => {
    let sum = 0;
    let wy = 0;
    for (let y = 0; y < f.gh; y++) {
      for (let x = 0; x < f.gw; x++) {
        const w = f.pigU[y * f.gw + x] + f.dryU[y * f.gw + x];
        sum += w;
        wy += y * w;
      }
    }
    return wy / sum;
  };
  let yMaxBefore = -1;
  for (let y = 0; y < dropFluid.gh; y++) {
    for (let x = 0; x < dropFluid.gw; x++) {
      if (dropFluid.wet[y * dropFluid.gw + x] > 0) yMaxBefore = y;
    }
  }
  const yBefore = centerY(dropFluid);
  for (let s = 0; s < 10; s++) dropFluid.step(0.04, false);
  assert.ok(centerY(dropFluid) - yBefore < 1);
  for (let s = 0; s < 40; s++) dropFluid.step(0.04, false);
  const yAfter = centerY(dropFluid);
  assert.ok(yAfter - yBefore > 0.6);
  let pigmentBelow = 0;
  for (let y = yMaxBefore + 1; y < dropFluid.gh; y++) {
    for (let x = 0; x < dropFluid.gw; x++) {
      const idx = y * dropFluid.gw + x;
      pigmentBelow += dropFluid.pigU[idx] + dropFluid.dryU[idx];
    }
  }
  assert.ok(pigmentBelow > 0);

  dropFluid.settleAll();
  assert.equal(dropFluid.active, false);
  for (let s = 0; s < 40; s++) dropFluid.decayDry(0.75);
  assert.equal(dropFluid.hasPaint, false);

  const glossFluid = new InkFluid();
  glossFluid.ensureSize(120, 120);
  const cx = Math.floor(glossFluid.gw / 2);
  const cy = Math.floor(glossFluid.gh / 2);
  for (let y = 0; y < glossFluid.gh; y++) {
    for (let x = 0; x < glossFluid.gw; x++) {
      const r2 = ((x - cx) ** 2 + (y - cy) ** 2) / 36;
      if (r2 < 1) glossFluid.dryN[y * glossFluid.gw + x] = (1 - r2) ** 2 * 1.1;
    }
  }
  glossFluid.hasPaint = true;
  glossFluid.dirtyRender = true;
  const data = new Uint8ClampedArray(glossFluid.gw * glossFluid.gh * 4);
  glossFluid.imgData = { data };
  glossFluid.offCtx = { putImageData() {} };
  glossFluid.offscreen = {};
  const ctx = { save() {}, restore() {}, drawImage() {} };

  glossFluid.render(ctx, 0, 0, 120, 120, true);
  const light = Uint8ClampedArray.from(data);
  glossFluid.render(ctx, 0, 0, 120, 120, false);
  assert.notDeepEqual(data, light);

  const centerP4 = (cy * glossFluid.gw + cx) << 2;
  const rowAlpha = Array.from({ length: glossFluid.gw }, (_, x) => data[((cy * glossFluid.gw + x) << 2) + 3]);
  assert.ok(data[centerP4 + 3] > 0 && data[centerP4 + 3] <= 170);
  assert.ok(Math.max(...rowAlpha) > data[centerP4 + 3]);
  assert.ok(data[centerP4 + 2] > data[centerP4]);
});

test('procedural watercolor blooms, glossy acrylic dabs, and middle sweeps render finite geometry', () => {
  const finite = (...args) => {
    for (const n of args) if (typeof n === 'number') assert.ok(Number.isFinite(n));
  };
  const ctx = new Proxy({}, { get: () => finite, set: () => true });
  const palette = { NEWS: '#1b3654', UP: '#18765c', DOWN: '#802230' };

  drawWatercolorBloom(ctx, 100, 80, 12, 0.8, 3.14, palette.NEWS, 1);
  drawWatercolorBloom(ctx, 100, 80, 10, 0, 2.5, palette.DOWN, -1);
  drawAcrylicDab(ctx, 140, 90, 12, 0.75, palette.NEWS);
  drawAcrylicDab(ctx, 140, 90, 9, 0, palette.UP);
  drawPublicSweep(ctx, 180, 18, 360, 0.65, 0.7, palette, true);
  drawPublicSweep(ctx, 180, 18, 360, 1.0, 0.5, palette, false);

  const calls = [];
  const trackingCtx = new Proxy({}, {
    get: (_, key) => (...args) => { calls.push([key, ...args]); },
    set: () => true
  });
  drawPublicSweep(trackingCtx, 180, 18, 360, 0, 0.8, palette, true);
  drawPublicSweep(trackingCtx, 180, 18, 360, 0.6, 0, palette, false);
  drawAcrylicDab(trackingCtx, 140, 90, 12, 0, palette.NEWS);
  assert.equal(calls.length, 0);
  drawPublicSweep(trackingCtx, 180, 18, 360, 0.5, 0.6, palette, true);
  assert.ok(calls.some(([fn]) => fn === 'fillRect'));
});

test('drawInkWashBand renders finite geometry and distinct positive vs negative directional colors', () => {
  const palette = { NEWS: '#1b3654', UP: '#18765c', DOWN: '#802230' };
  const record = (impact, isLight) => {
    const stops = [];
    const props = {};
    const calls = [];
    const ctx = new Proxy(props, {
      get: (target, key) => {
        if (key === 'createLinearGradient') {
          return (...args) => {
            for (const n of args) assert.ok(Number.isFinite(n));
            return { addColorStop: (_o, c) => stops.push(c) };
          };
        }
        return (...args) => {
          for (const n of args) if (typeof n === 'number') assert.ok(Number.isFinite(n));
          calls.push([key, ...args]);
        };
      },
      set: (target, key, val) => { target[key] = val; return true; }
    });
    drawInkWashBand(ctx, 20, 10, 120, 180, 0.8, 1.7, isLight, impact, 1.0);
    assert.ok(calls.some(([fn]) => fn === 'fillRect'));
    assert.ok(calls.some(([fn]) => fn === 'fill'));
    return { fill: stops[0], stroke: props.fillStyle };
  };

  for (const isLight of [true, false]) {
    const pos = record(5, isLight);
    const neg = record(-5, isLight);
    assert.notEqual(pos.fill, neg.fill);
    assert.notEqual(pos.stroke, neg.stroke);
    assert.notEqual(pos.fill, palette.NEWS);
    assert.notEqual(neg.fill, palette.NEWS);
    assert.notEqual(pos.stroke, palette.NEWS);
    assert.notEqual(neg.stroke, palette.NEWS);
  }
});

test('dry ink holds through an unabsorbed private phase and fades after public release', () => {
  const m = market(), ink = new InkPlayback();
  ink.update(m);
  ink.fluid.ensureSize(120, 60);
  ink.fluid.stampDryResidue(60, 30, 10, 0.6, 1);
  const total = () => ink.fluid.dryN.reduce((a, b) => a + b, 0);
  const start = total();
  for (let i = 0; i < 600; i++) { m.timeMs += 256; ink.update(m, 16, true); }
  assert.ok(m.timeMs < m.events[0].releaseMs);
  assert.equal(total(), start);
  m.timeMs = m.events[0].releaseMs;
  ink.update(m, 16, true);
  for (let i = 0; i < 200; i++) { m.timeMs += 256; ink.update(m, 16, true); }
  const settled = total();
  assert.ok(settled < start);
  assert.ok(settled > start * 0.6);
});

test('dry ink starts fading once price has absorbed the news, before release', () => {
  const m = { ...market(), price: 10000 }, ink = new InkPlayback();
  Object.assign(m.events[0], { startPrice: 10000, value: 10300 });
  ink.update(m);
  ink.fluid.ensureSize(120, 60);
  ink.fluid.stampDryResidue(60, 30, 10, 0.6, 1);
  const total = () => ink.fluid.dryN.reduce((a, b) => a + b, 0);
  const start = total();
  for (let i = 0; i < 100; i++) { m.timeMs += 256; ink.update(m, 16, true); }
  assert.equal(total(), start);
  m.price = 10300;
  for (let i = 0; i < 100; i++) { m.timeMs += 256; ink.update(m, 16, true); }
  assert.ok(m.timeMs < m.events[0].releaseMs);
  assert.ok(total() < start);
});
