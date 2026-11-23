import { CANDLE_SECONDS, TICK_SIZES } from './analytics.js';
import { SPEEDS } from './playback.js';
import { BURST_FLOOR } from './information.js';
import { EDGE_WINDOW_MS } from './views/panels.js';

const EDGE_WINDOW_MINUTES = EDGE_WINDOW_MS / 60000;
import { CONDITIONS, PRIVATE_WINDOW, ENGINE_CONFIG, DEFAULTS, DEFAULT_RATIOS, MAX_SIZE, logisticShare } from './model.js';

const NEWS = [
  ['news-impact', 'News size', 'True value jump (%)',
    -ENGINE_CONFIG.MAX_NEWS_IMPACT, ENGINE_CONFIG.MAX_NEWS_IMPACT, ENGINE_CONFIG.NEWS_IMPACT_STEP, ENGINE_CONFIG.NEWS_IMPACT],
  ['news-duration', 'Head start', 'Seconds before public release', ...PRIVATE_WINDOW.slice(3)]
];

const RATIO_LABELS = [
  ['maker', 'Makers'],
  ['value', 'Value'],
  ['trend', 'Trend'],
  ['random', 'Random']
];

const DIAGNOSTICS = [
  ['Source', 'Who sent the orders'],
  ['Planned', 'Orders the model expects so far'],
  ['Created', 'Orders the model created'],
  ['Sent', 'Orders that reached the book'],
  ['Traded', 'Orders that traded']
];

const intervalLabel = s => s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`;

export const intervalOptions = axis => axis === 'tick'
  ? TICK_SIZES.map(size => `<option value="${size}"${size === 12 ? ' selected' : ''}>${size}t</option>`).join('')
  : `<option value="0">Auto</option>${CANDLE_SECONDS.map(s => `<option value="${s}">${intervalLabel(s)}</option>`).join('')}`;

const escape = text => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const fields = (params, type = 'range', prefix = '') =>
  params.map(([key, symbol, title, min, max, step, value]) => {
    const id = prefix + key;
    return `<div title="${escape(title)}">
            <label class="slider-label" for="${id}">${escape(symbol)}<output id="${id}-value"></output></label>
            <input id="${id}" type="${type}" min="${min}" max="${max}" step="${step}" value="${value}">
          </div>`;
  }).join('');

const paramSliders = model => fields(model.params, 'range', 'p-');

const settingRow = (id, label, output, min, max, step, value, title = '') =>
  `<div class="setting-row"${title && ` title="${title}"`}>
              <label for="${id}">${label}</label>
              <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">
              <output id="${id}-value" for="${id}">${output}</output>
            </div>`;

const [NEWS_X, PUBLIC_X] = [44, 244];
const BURSTS = [[0.2, 0.045, 0.6], [0.38, 0.06, 1.1], [0.52, 0.04, 0.5], [0.68, 0.055, 1.2], [0.84, 0.045, 0.8]];
const BURST_MEAN = BURST_FLOOR + BURSTS.reduce((sum, [, w, h]) => sum + h * w * Math.sqrt(2 * Math.PI), 0);
const progress = x => (x - NEWS_X) / (PUBLIC_X - NEWS_X);
const share = x => x <= NEWS_X ? 0 : logisticShare(x - NEWS_X, PUBLIC_X - NEWS_X);
const burst = x => (BURST_FLOOR + BURSTS.reduce((sum, [at, w, h]) => sum + h * Math.exp(-(((progress(x) - at) / w) ** 2) / 2), 0)) / BURST_MEAN;
const orders = x => x > NEWS_X && x < PUBLIC_X ? share(x) * burst(x) : 0;
const gap = x => x < PUBLIC_X ? 0.75 * share(x) : 1 - 0.25 * Math.exp((PUBLIC_X - x) / 8);
const curve = (f, base, h) => Array.from({ length: 153 }, (_, i) => `${8 + 2 * i},${(base - h * f(8 + 2 * i)).toFixed(1)}`).join(' ');

export function renderInterface(model) {
  return `<main id="market" class="shell" tabindex="-1">
    <div class="topbar">
      <header class="identity">
        <h1>Hearsay</h1>
      </header>
      <nav class="transport" aria-label="Simulation controls">
        <button id="play" class="primary">Pause</button>
        <button id="restart" title="Reset (R)">Reset</button>
        <label class="speed-control">
          <select id="speed" aria-label="Playback speed">
            ${SPEEDS.map(speed => `<option value="${speed}" ${speed === 64 ? 'selected' : ''}>${speed}×</option>`).join('')}
          </select>
        </label>
        <span class="clock">
          <i id="status-dot"></i>
          <span id="status" class="sr-only">Running</span>
          <time id="clock">00:00:00</time>
        </span>
        <label class="theme-control"><select id="theme" aria-label="Color theme"><option value="dark">Dark</option><option value="light">Light</option></select></label>
      </nav>
    </div>

    <section class="figures" aria-label="Market summary">
      <div class="quote">
        <strong id="price">100.00</strong>
        <b id="change">0.00%</b>
      </div>
      <div><span class="label">Spread</span><strong id="top-spread">—</strong></div>
      <div><span class="label">Vol</span><strong id="top-vol">0.0 bps</strong></div>
      <div><span class="label">Bal</span><strong id="top-imbalance">0%</strong></div>
      <div><span class="label">Trades</span><strong id="trades">0</strong></div>
      <div><span class="label">Depth</span><strong><span id="buy-depth">0</span> / <span id="sell-depth">0</span></strong></div>
    </section>

    <div class="cockpit">
      <div class="stage">
        <section class="history-card" data-panel="history" aria-label="Price">
          <div class="section-head">
            <div class="chart-controls">
              <span class="switch" role="group" aria-label="Chart axis">
                <button type="button" data-axis="time" aria-pressed="true">Time</button>
                <button type="button" data-axis="tick" aria-pressed="false">Tick</button>
              </span>
              <select id="chart-interval" aria-label="Candle interval">${intervalOptions('time')}</select>
              <span class="switch" role="group" aria-label="Chart style">
                <button type="button" data-style="candle" aria-pressed="true">Candle</button>
                <button type="button" data-style="line" aria-pressed="false">Line</button>
              </span>
            </div>
          </div>
          <div class="history-wrap">
            <canvas id="history" role="img" aria-label="Price history. Drag to pan, double-click to return to live, click a news mark to inspect it."></canvas>
          </div>
        </section>
      </div>

      <aside class="dock" aria-label="Analysis and controls">
        <div class="dock-tabs" role="tablist">
          <button type="button" class="dock-tab active" data-tab="traders" role="tab" aria-selected="true">Traders</button>
          <button type="button" class="dock-tab" data-tab="book" role="tab" aria-selected="false">Book</button>
          <button type="button" class="dock-tab" data-tab="news" role="tab" aria-selected="false">News</button>
          <button type="button" class="dock-tab" data-tab="flow" role="tab" aria-selected="false">Flow</button>
          <button type="button" class="dock-tab" data-tab="ledger" role="tab" aria-selected="false">Ledger</button>
          <button type="button" class="dock-tab icon" data-tab="settings" role="tab" aria-selected="false" aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          <button type="button" class="dock-tab help" data-tab="model" role="tab" aria-selected="false" aria-label="How the simulation works" title="How the simulation works">?</button>
        </div>

        <div class="dock-body">
          <section class="field-panel tab-pane active" data-tab-pane="traders" data-panel="field" aria-label="Traders">
            <div class="section-head">
              <select id="field-mode" aria-label="Color traders by">
                <option value="awareness" selected>News</option>
                <option value="pnl">P&amp;L</option>
                <option value="inventory">Inventory</option>
              </select>
            </div>
            <div class="canvas-wrap">
              <canvas id="field" tabindex="0" role="img" aria-label="Traders by strategy and price belief"></canvas>
            </div>
            <output id="trader-detail" class="trader-detail" aria-live="polite" hidden></output>
          </section>

          <section id="order-book" class="book-card tab-pane" data-tab-pane="book" data-panel="book" aria-label="Order book">
            <div class="book-depth-wrap">
              <canvas id="book-depth" role="img" aria-label="Bid and ask depth curve"></canvas>
            </div>
            <div class="book-heading">
              <span>Buy</span>
              <span>Bid</span>
              <span>Ask</span>
              <span>Sell</span>
            </div>
            <div id="book-levels"></div>
          </section>

          <section class="episode tab-pane" data-tab-pane="news" data-panel="episode" aria-label="News">
            <div class="episode-wrap">
              <canvas id="episode" role="img" aria-label="News knowledge and informed order rate on the left axis; observed price response on the right axis"></canvas>
            </div>
            <p class="episode-legend">
              <span><i class="swatch swatch-news"></i><code>I(t)</code></span>
              <span><i class="swatch swatch-accent swatch-dashed"></i><code>E[λ]</code></span>
              <span><i class="swatch swatch-accent"></i><code>λ(t)</code></span>
              <span><i class="swatch swatch-up"></i><code>D(t)</code></span>
            </p>
            <div class="params">
              ${fields(NEWS, 'number')}
              <div id="model-params">${paramSliders(model)}</div>
            </div>
            <div class="episode-actions">
              <button id="release-news" class="news-button" title="Start a news event using the current news size and head start (N)">Start news</button>
              <button id="auto-news" aria-pressed="true">Random: on</button>
              <div class="auto-rate">
                <label class="slider-label" for="auto-rate">
                  Rate<output id="auto-rate-value">${ENGINE_CONFIG.AUTO_RATE_PER_HOUR}/h</output>
                </label>
                <input id="auto-rate" type="range" min="1" max="120" step="1" value="${ENGINE_CONFIG.AUTO_RATE_PER_HOUR}">
              </div>
            </div>
            <p id="news-feedback" class="feedback" role="status" aria-live="polite"></p>
          </section>

          <section class="flow-card tab-pane" data-tab-pane="flow" data-panel="flow" aria-label="Trade sizes">
            <div class="section-head">
              <label class="check">
                <input id="flow-log" type="checkbox" checked>log
              </label>
            </div>
            <div class="flow-wrap">
              <canvas id="flow" role="img" aria-label="Trade size histogram"></canvas>
            </div>
            <p id="flow-summary" class="figure"></p>
            <div id="latest-fills" class="latest-fills"></div>
          </section>

          <section id="diagnostics-panel" class="diagnostics-card tab-pane" data-tab-pane="ledger" data-panel="diagnostics" aria-label="Ledger">
            <div class="edge-wrap">
              <canvas id="edge" role="img" aria-label="Gain vs. just holding per strategy over the last ${EDGE_WINDOW_MINUTES} minutes, in dollars. Shaded bands are news windows. Hover for values."></canvas>
            </div>
            <table class="ledger-table edge-table">
              <thead>
                <tr><th>Group</th><th title="Gain since start">Total</th><th title="Gain per trader since start">Each</th><th id="edge-window" title="Gain in the chart window"></th></tr>
              </thead>
              <tbody id="edge-table"></tbody>
            </table>
            <h3 title="Shares traded in the last 500 trades. Row: trader who took a waiting order. Column: trader whose order waited.">Who trades with whom</h3>
            <div class="matrix-wrap">
              <canvas id="matrix" role="img" aria-label="Shares traded between strategies: taker rows, resting-order columns"></canvas>
            </div>
            <h3 title="Everyday: routine orders. Insiders: orders on private news. Makers: quotes that wait in the book.">Orders by source</h3>
            <div class="diagnostics-scroll">
            <table class="ledger-table">
              <thead>
                <tr>${DIAGNOSTICS.map(([name, title]) => `<th title="${title}">${name}</th>`).join('')}</tr>
              </thead>
              <tbody id="diagnostics"></tbody>
            </table>
            </div>
          </section>

          <section id="conditions" class="tab-pane" data-tab-pane="settings" data-panel="conditions">
            <label class="setting-label" for="preset">
              Preset
              <select id="preset">
                <option value="balanced">Balanced</option>
                <option value="trend">Trend-driven</option>
                <option value="thin">Thin market</option>
                <option value="custom" hidden>Custom</option>
              </select>
            </label>
            ${CONDITIONS.map(([id, label, , min, max, step, value]) =>
              settingRow(id, label, `${value}${id === 'activity' ? '/s' : '%'}`, min, max, step, value)
            ).join('')}
            <label class="setting-label" for="population-input">
              Traders
              <input id="population-input" type="number" min="${ENGINE_CONFIG.POPULATION_MIN}" max="${ENGINE_CONFIG.POPULATION_MAX}" step="1" value="${DEFAULTS.population}">
            </label>
            <h3>Trader mix</h3>
            ${RATIO_LABELS.map(([key, label]) =>
              settingRow(`ratio-${key}`, label, `${DEFAULT_RATIOS[key]}%`, 0, 100, 1, DEFAULT_RATIOS[key])
            ).join('')}
            <label class="setting-label" for="seed">
              Seed
              <input id="seed" type="number" min="0" max="${ENGINE_CONFIG.SEED_MAX}" step="1" value="${DEFAULTS.seed}">
            </label>
            ${settingRow('refresh-ms', 'Number refresh', '125 ms', 0, 1000, 25, 125, 'Minimum time between updates of the numbers on screen')}
          </section>

          <section id="model-panel" class="tab-pane" data-tab-pane="model" aria-label="How the simulation works">
            <figure class="model-viz">
              <svg viewBox="0 0 320 170" role="img" aria-label="Timeline of one news story on a shared time axis. Who knows rises in an S-curve from news to public release. Insider orders follow it in bursts and stop at release. The price moves toward the new value and closes the gap after release.">
                <defs><filter id="viz-ink" x="-2%" y="-10%" width="104%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.04 0.6" numOctaves="2" seed="5" /><feDisplacementMap in="SourceGraphic" scale="1.2" /></filter></defs>
                <g class="viz-rules">
                  <line x1="8" y1="44" x2="312" y2="44" />
                  <line x1="8" y1="94" x2="312" y2="94" />
                  <line x1="8" y1="152" x2="312" y2="152" />
                </g>
                <path class="viz-marks" d="${[NEWS_X, PUBLIC_X].map(x => `M${x},14V44M${x},64V94M${x},114V155`).join('')}" />
                <text x="8" y="10"><tspan class="viz-k viz-news">I(t)</tspan> who knows</text>
                <text x="8" y="60"><tspan class="viz-k viz-accent">λ(t)</tspan> insider orders</text>
                <text x="8" y="110"><tspan class="viz-k viz-up">D(t)</tspan> price → new value</text>
                <g filter="url(#viz-ink)">
                  <polyline points="${curve(share, 44, 28)}" class="viz-line viz-news" />
                  <polygon points="${curve(orders, 94, 12)} 312,94 8,94" class="viz-area viz-accent" />
                  <polyline points="${curve(x => x < PUBLIC_X ? share(x) : 0, 94, 12)}" class="viz-trend viz-accent" />
                  <polyline points="8,144 ${NEWS_X},144 ${NEWS_X},118 312,118" class="viz-trend" />
                  <polyline points="${curve(gap, 144, 26)}" class="viz-line viz-up" />
                </g>
                <text x="312" y="114" text-anchor="end">new value</text>
                <text x="${NEWS_X}" y="165" text-anchor="middle" class="viz-tag">news</text>
                <text x="${PUBLIC_X}" y="165" text-anchor="middle" class="viz-tag">public</text>
                <text x="312" y="165" text-anchor="end">time →</text>
              </svg>
            </figure>
            <ol class="model-steps">
              <li><b>News arrives</b><p>The true value jumps, for example by +${ENGINE_CONFIG.NEWS_IMPACT}%. Nobody sees it yet.</p></li>
              <li><b>A few traders hear it first <code>I(t)</code></b><p>Word spreads in private: slowly, then fast, then it levels off. At public release everyone knows.</p></li>
              <li><b>They trade on it <code>λ(t)</code></b><p>Insiders buy on good news and sell on bad news. More insiders send more orders, in bursts.</p></li>
              <li><b>The order book matches orders</b><p>Each order trades with the best waiting order on the other side. Makers keep the book full. Everyday orders add noise.</p></li>
              <li><b>The price moves to the new value <code>D(t)</code></b><p>Each trade moves the price. D(t) is the part of the gap closed: 0% at the start, 100% at the new value.</p></li>
              <li><b>The news goes public</b><p>Everyone learns the news. The rest of the gap closes fast and insiders lose their edge.</p></li>
            </ol>
            <details class="model-math">
              <summary>The formulas</summary>
              <dl>
                <div><dt><code>s(t) = σ(10(t/W − ½))</code></dt><dd>Logistic spread. W = head start.</dd></div>
                <div><dt><code>I(t) = (s(t) − s(0)) / (s(W) − s(0))</code></dt><dd>Share who know: 0 at news, 1 at release.</dd></div>
                <div><dt><code>λ(t) ∝ I(t) × burst(t)</code></dt><dd>Insider order rate. burst(t) has mean 1.</dd></div>
                <div><dt><code>D(t) = (P − P₀) / (V* − P₀)</code></dt><dd>Gap closed. P₀ = start price, V* = new value.</dd></div>
                <div><dt><code>N ~ Poisson(Λ), Λ ~ Gamma</code></dt><dd>Everyday orders come in bursts.</dd></div>
                <div><dt><code>P(q) ∝ q⁻¹·⁵, q ≤ ${MAX_SIZE}</code></dt><dd>Most orders are small, a few are large.</dd></div>
                <div><dt><code>fee = ${ENGINE_CONFIG.TAKER_FEE_BPS} bps</code></dt><dd>The taker pays the maker.</dd></div>
                <div><dt><code>cash ≥ 0, shares ≥ 0</code></dt><dd>No borrowing, no short selling.</dd></div>
              </dl>
            </details>
          </section>
        </div>
      </aside>
    </div>

    <p id="notice" class="notice" role="status" aria-live="polite"></p>
  </main>`;
}
