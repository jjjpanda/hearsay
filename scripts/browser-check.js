import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFile, copyFile } from 'node:fs/promises';
import { startBrowser, startServer, root, artifacts, pause } from './browser-driver.js';

const site = process.argv.slice(2).find(arg => !arg.startsWith('--')) || '.';
const server = await startServer(resolve(root, site));
const siteUrl = server.url;
let browser;
try { browser = await startBrowser(); } catch (error) { server.close(); throw error; }

const { command, evaluate, screenshot, metrics, errors } = browser;
const ready = async () => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate('Boolean(document.querySelector("market-ecosystem")?.market)')) return;
    await pause(100);
  }
  throw new Error('Market did not initialize');
};
const click = id => evaluate(`document.querySelector('market-ecosystem').shadowRoot.getElementById(${JSON.stringify(id)}).click()`);
const state = expression => evaluate(`(() => { const e = document.querySelector('market-ecosystem'), s = e.shadowRoot; return (${expression}); })()`);
const run = code => evaluate(`(() => { const e = document.querySelector('market-ecosystem'), s = e.shadowRoot; ${code} })()`);

try {
  await metrics(1440, 1000);
  await command('Page.navigate', { url: siteUrl + '/?autoplay=false' });
  await ready();
  await pause(200);

  assert.deepEqual(
    await state('[e.market.agents.length, e.speed, e.activeTab, e.playing, e.market.timeMs, e.market.tradeCount, e.market.price]'),
    [250, 64, 'traders', false, 0, 0, 10000]
  );
  assert.ok(await state('e.market.book().bid < e.market.book().ask'));

  await run('e.advanceSafely(1000);');
  assert.equal(await state('e.market.timeMs'), 1000);
  assert.ok(await state('e.market.tradeCount > 0'));

  await click('play');
  for (let i = 0; i < 40 && !(await state('e.market.timeMs > 1000')); i++) await pause(50);
  await click('play');
  assert.ok(await state('e.market.timeMs > 1000'));
  const pausedAt = await state('e.market.timeMs');
  await pause(120);
  await run('e.draws = 0; const draw = e.view.draw.bind(e.view); e.view.draw = (...a) => { e.draws++; return draw(...a); };');
  await pause(160);
  assert.equal(await state('e.market.timeMs'), pausedAt);
  assert.equal(await state('e.draws'), 0);

  await click('restart');
  assert.deepEqual(await state('[e.market.timeMs, e.market.tradeCount, e.market.events.length]'), [0, 0, 0]);

  await run('e.setRandomNews(false); s.querySelector("[data-tab=news]").click();');
  await pause(50);
  assert.deepEqual(
    await state('[s.getElementById("news-impact").value, s.getElementById("news-impact-value").textContent, s.getElementById("news-duration").value, s.getElementById("news-duration-value").textContent]'),
    ['2', '+2.0%', '300', '5 min']
  );

  await click('release-news');
  assert.equal(await state('e.market.events.length'), 1);
  assert.equal(await state('s.getElementById("news-feedback").textContent'), '');
  assert.equal(await state('s.getElementById("release-news").disabled'), true);

  await run('e.advanceSafely(60000); e.refresh();');
  const progress = await state('e.market.newsProgress()');
  assert.ok(progress.known > 0 && progress.known < 250);
  assert.ok(await state('e.market.diagnostics.informed.generated > 0'));

  await run(`
    s.getElementById('news-impact').value = '4';
    s.getElementById('news-impact').dispatchEvent(new Event('input'));
    s.getElementById('news-duration').value = '120';
    s.getElementById('news-duration').dispatchEvent(new Event('input'));
  `);
  assert.deepEqual(
    await state('[s.getElementById("news-impact-value").textContent, s.getElementById("news-duration-value").textContent]'),
    ['+4.0%', '2 min']
  );

  await run('e.advanceSafely(300000 - e.market.timeMs + 1000); e.refresh();');
  assert.equal(await state('e.market.episodeId'), null);
  assert.equal(await state('e.market.newsProgress().known'), 250);
  assert.equal(await state('s.getElementById("release-news").disabled'), false);

  await run('e.market.news(-3, 180); e.refresh();');
  assert.deepEqual(
    await state('[s.getElementById("news-impact").value, s.getElementById("news-impact-value").textContent, s.getElementById("news-duration").value, s.getElementById("news-duration-value").textContent]'),
    ['-3', '-3.0%', '180', '3 min']
  );

  for (const [tab, canvasId] of [['book', 'book-depth'], ['flow', 'flow'], ['ledger', 'edge'], ['ledger', 'matrix'], ['settings', null], ['model', null]]) {
    await run(`s.querySelector("[data-tab=${tab}]").click(); e.view.draw(e.market, 0, false);`);
    await pause(40);
    if (canvasId) assert.ok(await state(`s.getElementById("${canvasId}").getBoundingClientRect().height > 0`), tab);
  }

  await run('s.querySelector("[data-tab=settings]").click(); s.getElementById("preset").value = "thin"; s.getElementById("preset").dispatchEvent(new Event("change"));');
  assert.equal(await state('e.market.settings.liquidity'), 20);
  assert.equal(await state('e.market.clock.rate'), 15);
  await run('s.getElementById("activity").value = "45"; s.getElementById("activity").dispatchEvent(new Event("input"));');
  assert.equal(await state('s.getElementById("activity-value").textContent'), '45/s');
  assert.equal(await state('e.market.clock.rate'), 45);

  await run('s.querySelector("[data-tab=traders]").click(); e.refresh(); e.view.draw(e.market, 0, false);');
  await pause(60);
  const point = await state('(() => { const p = e.view.positions.find(p => e.market.agents[p.id].reach < 1); const r = s.getElementById("field").getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; })()');
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  assert.notEqual(await state('e.view.selected'), null);
  assert.equal(await state('s.getElementById("trader-detail").hidden'), false);
  assert.ok(await state('s.getElementById("trader-detail").textContent.includes("thinks $")'));
  assert.ok(await state('s.getElementById("trader-detail").textContent.includes("cash $")'));

  const selected = await state('e.view.selected');
  await run('s.getElementById("field").focus();');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
  assert.notEqual(await state('e.view.selected'), selected);

  await run('e.presentationState = JSON.stringify(e.market); e.setAttribute("theme", "light");');
  await pause(80);
  assert.equal(await state('e.view.theme'), 'light');
  assert.equal(await state('getComputedStyle(e).colorScheme'), 'light');
  assert.equal(await state('JSON.stringify(e.market) === e.presentationState'), true);
  await run('e.setAttribute("theme", "dark");');

  await command('Page.navigate', { url: siteUrl + '/' });
  await ready();
  await pause(150);
  const perf = await evaluate(`new Promise(resolve => {
    const e = document.querySelector('market-ecosystem');
    e.setRandomNews(false);
    e.market.news(2, 300);
    const start = performance.now(), sim = e.market.timeMs;
    let frames = 0, last = start;
    function frame(now) {
      frames++;
      last = now;
      if (now - start < 2000) requestAnimationFrame(frame);
      else resolve({ fps: frames * 1000 / (now - start), simulated: e.market.timeMs - sim, elapsed: now - start });
    }
    requestAnimationFrame(frame);
  })`);
  console.log('64x browser benchmark:', JSON.stringify(perf));
  assert.ok(perf.fps >= 30, `Expected at least 30 FPS, got ${perf.fps}`);
  assert.ok(perf.simulated >= perf.elapsed * 64 * 0.8, '64x should keep pace');

  await metrics(390, 844);
  await pause(120);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile must fit horizontally');

  await metrics(800, 500);
  await command('Page.navigate', { url: siteUrl + '/embed/?seed=123&speed=16&autoplay=false' });
  await ready();
  await pause(150);
  assert.equal(await state('e.market.initialSeed'), 123);
  assert.equal(await state('e.speed'), 16);
  assert.equal(await state('getComputedStyle(s.querySelector(".dock")).display'), 'none');
  assert.ok(await state('s.getElementById("history").getBoundingClientRect().bottom <= innerHeight'));

  await command('Page.navigate', { url: siteUrl + '/embed?seed=7&seed=9&preset=thin&theme=light&transparent&autofocus&autoplay=false&width=700&height=450' });
  await ready();
  await pause(150);
  assert.deepEqual(await state('[e.market.initialSeed, e.market.settings.liquidity, e.market.clock.rate, e.view.theme, e.playing]'), [7, 20, 15, 'light', false]);
  assert.equal(await state('s.activeElement.id'), 'market');
  assert.equal(await state('e.getBoundingClientRect().height'), 450);
  assert.equal(await state('getComputedStyle(e).backgroundColor'), 'rgba(0, 0, 0, 0)');
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgba(0, 0, 0, 0)');

  if (site === '.') {
    await metrics(1440, 1000);
    await command('Page.navigate', { url: siteUrl + '/?seed=24816&theme=light&autoplay=false' });
    await ready();
    await run('e.setRandomNews(false); e.advanceSafely(60000); e.market.news(2, 300); e.advanceSafely(90000); e.refresh(); e.view.draw(e.market, 0, false);');
    await pause(150);
    await screenshot('public-demo');
    await copyFile(resolve(artifacts, 'public-demo.png'), resolve(root, 'screenshots/marketsim.png'));
  }

  assert.deepEqual(errors, []);
  const report = { status: 'passed', site, checkedAt: new Date().toISOString(), browser: browser.version.product, performance: perf, errors };
  for (const name of ['browser.json', browser.runId + '.json']) {
    await writeFile(resolve(artifacts, name), JSON.stringify(report, null, 2));
  }
  console.log('Browser checks passed.');
} catch (error) {
  const report = { status: 'failed', checkedAt: new Date().toISOString(), browser: browser.version.product, error: error.stack, errors };
  for (const name of ['browser-failure.json', browser.runId + '.json']) {
    await writeFile(resolve(artifacts, name), JSON.stringify(report, null, 2));
  }
  throw error;
} finally {
  await browser.close();
  server.close();
}
