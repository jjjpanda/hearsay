import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPageOptions, readOptions } from '../src/options.js';

test('page options use the first URL value and preserve the embed route', () => {
  const attrs = new Map([['embed', '']]);
  const element = { hasAttribute: key => attrs.has(key), setAttribute: (key, value) => attrs.set(key, value) };
  applyPageOptions(element, '?seed=7&seed=9&population=200&embed=false&theme=light&transparent&unknown=1');
  const options = readOptions(key => attrs.get(key) ?? null);
  assert.equal(options.seed, 7);
  assert.equal(options.population, 200);
  assert.equal(options.embed, true);
  assert.equal(options.transparent, true);
  assert.equal(options.theme, 'light');
  assert.equal(attrs.has('unknown'), false);
});

test('invalid options fall back and dimensions are finite, rounded and bounded', () => {
  const values = { seed: '4294967296', population: '9999', speed: '2', preset: '__proto__', theme: 'unknown', transparent: 'yes', width: '9000', height: '450.4' };
  const options = readOptions(key => values[key] ?? null);
  assert.equal(options.seed, 24816);
  assert.equal(options.population, 250);
  assert.equal(options.speed, 64);
  assert.equal(options.preset, 'balanced');
  assert.equal(options.theme, 'dark');
  assert.equal(options.transparent, false);
  assert.equal(options.width, 4096);
  assert.equal(options.height, 450);
  assert.equal(readOptions(() => 'Infinity').width, null);
  assert.equal(readOptions(() => '-5').height, null);
  assert.equal(readOptions(key => key === 'speed' ? '256' : null).speed, 256);
});

test('headless package exports work without browser globals', async () => {
  const { Market } = await import('marketsim/sim');
  const { NEUTRAL } = await import('marketsim/model');
  assert.equal(new Market({ model: NEUTRAL }).modelId, 'public-demo-v1');
});
