import { credits, elapsed, money, signed } from './clock.js';
import { activeEpisode } from './information.js';
import { marketMetrics } from './metrics.js';
import { ENGINE_CONFIG } from './model.js';
import { EDGE_WINDOW_MS, edgeWindow, levelInk, trackBookInk } from './views/panels.js';
import { LANE_LABELS } from './views/canvas.js';

const formatNumber = num => num.toLocaleString('en-US');

export function updateFigures(host, market, book, mm = marketMetrics(market, book)) {
  host.el('price').textContent = credits(market.price);

  const pricePercentChange = (market.price / 10000 - 1) * 100;
  host.el('change').textContent = signed(pricePercentChange, 2);
  host.el('change').classList.toggle('up', pricePercentChange > 0);
  host.el('change').classList.toggle('down', pricePercentChange < 0);
  host.el('top-spread').textContent = mm.spreadTicks === null ? '—' : `${mm.spreadBps.toFixed(1)} bps`;
  host.el('top-vol').textContent = `${market.volatility.toFixed(1)} bps`;

  const imbPct = Math.round(mm.imbalance * 100);
  host.el('top-imbalance').textContent = `${imbPct > 0 ? '+' : ''}${imbPct}%`;
  host.el('top-imbalance').classList.toggle('up', imbPct > 10);
  host.el('top-imbalance').classList.toggle('down', imbPct < -10);

  host.el('clock').textContent = elapsed(market.timeMs);
  host.el('status').textContent = host.playing ? 'Running' : 'Paused';
  host.el('status-dot').classList.toggle('paused', !host.playing);
  host.el('play').textContent = host.playing ? 'Pause' : 'Run';
  host.el('play').setAttribute(
    'aria-label',
    host.playing ? 'Pause simulation' : 'Run simulation'
  );

  host.el('trades').textContent = formatNumber(market.tradeCount);
  host.el('buy-depth').textContent = formatNumber(book.buyDepth);
  host.el('sell-depth').textContent = formatNumber(book.sellDepth);
}

export function updateNews(host, market) {
  host.el('auto-rate-value').textContent = `${host.el('auto-rate').value}/h`;

  const latestEvent = market.events.at(-1) ?? null;
  const eventStamp = market.events.map(event => event.id).join(',');
  if (eventStamp !== host.eventStamp) {
    host.view.selectedEventId = latestEvent ? latestEvent.id : null;
    host.eventStamp = eventStamp;
  }

  const active = activeEpisode(market);
  const selected = host.view.selectedEventId !== null
    ? market.events.find(event => event.id === host.view.selectedEventId) ?? null
    : null;
  const shown = selected ?? active ?? latestEvent;

  const impactInput = host.el('news-impact');
  const durationInput = host.el('news-duration');
  const focused = host.shadowRoot?.activeElement;
  if (shown && shown.id !== host.syncedEventId) {
    host.syncedEventId = shown.id;
    if (focused !== impactInput) impactInput.value = String(+shown.impact.toFixed(2));
    if (focused !== durationInput) durationInput.value = String(shown.durationSeconds);
    for (const key of host.episodeKeys) {
      const input = host.input(key);
      if (shown.params?.[key] !== undefined && focused !== input) {
        input.value = String(shown.params[key]);
      }
    }
  } else if (!shown) {
    host.syncedEventId = null;
  }

  const rawImpact = impactInput.value;
  const impact = rawImpact === '' ? NaN : Number(rawImpact);
  const rawDuration = durationInput.value;
  const duration = rawDuration === '' ? NaN : Number(rawDuration);

  host.el('news-impact-value').textContent = Number.isFinite(impact) ? signed(impact) : '—';
  host.el('news-duration-value').textContent = !Number.isFinite(duration)
    ? '—'
    : duration < 60
      ? `${duration}s`
      : `${Number((duration / 60).toFixed(1))} min`;

  for (const key of host.episodeKeys) {
    host.el(`p-${key}-value`).textContent = host.input(key).value;
  }

  const validImpact = Number.isFinite(impact) && impact !== 0 && Math.abs(impact) <= ENGINE_CONFIG.MAX_NEWS_IMPACT;
  host.el('release-news').disabled = !validImpact || active !== null;
  host.el('release-news').textContent = active
    ? `Public in ${Math.ceil((active.releaseMs - market.timeMs) / 1000)}s`
    : validImpact
      ? 'Start news'
      : 'Set news size';
}

export function updateBook(host, market, book, mm = marketMetrics(market, book), includeLevels = true, includeFills = true) {
  const ink = trackBookInk(host.view, market, book);
  if (includeLevels) {
    const maxQty = Math.max(1, ...book.buyLevels.map(l => l.qty), ...book.sellLevels.map(l => l.qty));
    const qtyCell = (side, level) => {
      const { wet, cut } = levelInk(ink, level && ink.levels.get(level.price));
      const style = `--depth:${level ? Math.round((level.qty / maxQty) * 100) : 0}%;--wet:${wet.toFixed(2)};--cut:${cut.toFixed(2)}`;
      return `<span class="${side}-qty" style="${style}">${level ? formatNumber(level.qty) : '—'}</span>`;
    };
    host.el('book-levels').innerHTML = Array.from({ length: 5 }, (_, index) => {
      const buyLevel = book.buyLevels[index];
      const sellLevel = book.sellLevels[index];
      return `<div class="book-row">
        ${qtyCell('bid', buyLevel)}
        <span class="bid-px">${buyLevel ? credits(buyLevel.price) : '—'}</span>
        <span class="ask-px">${sellLevel ? credits(sellLevel.price) : '—'}</span>
        ${qtyCell('ask', sellLevel)}
      </div>`;
    }).join('');
  }

  if (includeFills) {
    host.el('latest-fills').innerHTML =
      market.trades
        .slice(-120)
        .reverse()
        .map(
          trade =>
            `<div class="fill-row">
              <span>${elapsed(trade.timeMs)}</span>
              <span class="${trade.side}">${trade.side === 'buy' ? '+' : '−'}${trade.qty}</span>
              <span>@ ${credits(trade.price)}</span>
              <span>${trade.origin}</span>
            </div>`
        )
        .join('') || '<p class="empty">—</p>';

    const ofiPct = Math.round(mm.ofi * 100);
    const infPct = Math.round(mm.informedShare * 100);
    host.el('flow-summary').textContent = `OFI ${ofiPct > 0 ? '+' : ''}${ofiPct}% · ${infPct}% informed`;
  }
}

export function updateDiagnostics(host, market) {
  const expected = market.expectedAttempts();
  const counts = market.diagnostics;

  host.el('diagnostics').innerHTML = ['baseline', 'informed', 'maker']
    .map(origin => {
      const title = { baseline: 'Everyday', informed: 'Insiders', maker: 'Makers' }[origin];
      const isMaker = origin === 'maker';
      const expectedCell = isMaker
        ? '—'
        : expected[origin].toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const generatedCell = isMaker ? '—' : formatNumber(counts[origin].generated);
      const trades = market.flow.byOrigin[origin];
      return `<tr>
        <th>${title}</th>
        <td data-label="Planned">${expectedCell}</td>
        <td data-label="Created">${generatedCell}</td>
        <td data-label="Sent">${formatNumber(counts.submitted[origin])}</td>
        <td data-label="Traded">${isMaker && !trades ? '—' : formatNumber(trades)}</td>
      </tr>`;
    })
    .join('');

  const points = edgeWindow(market);
  const [first, now] = [points[0].edge, points.at(-1).edge];
  const members = Object.fromEntries(Object.keys(now).map(type => [type, market.agents.filter(a => a.type === type).length]));
  host.el('edge-window').textContent = `Last ${EDGE_WINDOW_MS / 60000} min`;
  host.el('edge-table').innerHTML = Object.keys(now)
    .sort((a, b) => now[b] - now[a])
    .map(type => `<tr>
        <th>${LANE_LABELS[type]}</th>
        <td data-label="Total">${money(now[type])}</td>
        <td data-label="Each">${money(members[type] ? now[type] / members[type] : 0)}</td>
        <td data-label="Last ${EDGE_WINDOW_MS / 60000} min">${money(now[type] - first[type])}</td>
      </tr>`)
    .join('');
}

