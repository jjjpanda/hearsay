import { performance } from 'node:perf_hooks';
import { Market } from '../src/sim.js';
import { NEUTRAL } from '../src/model.js';

const results = [];

for (let run = 0; run < 5; run++) {
  const start = performance.now();
  const market = new Market({ model: NEUTRAL });
  const startupMs = performance.now() - start;

  const begin = performance.now();
  for (let i = 0; i < 10; i++) {
    if (i % 5 === 0) {
      market.news(i ? -2 : 2, 300);
    }
    market.advance(60000);
  }
  market.assertAccounting();

  results.push({
    startupMs: +startupMs.toFixed(2),
    tenMinutesMs: +(performance.now() - begin).toFixed(2),
    trades: market.tradeCount
  });
}

console.table(results);
