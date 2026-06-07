import { DEFAULT_RANKING_CONFIG } from "../enrichers/momentum-types.js";
import type { DashboardPayload, WatchlistBriefingRow } from "./queries.js";

const TG_MAX = 4096;
/** Three substantive sentences for bench context (Telegram readability). */
const WATCHLIST_RATIONALE_MAX = 280;
const TICKER_COL_WIDTH = 5;
const PRICE_COL_WIDTH = 9;

const SECTOR_LABEL: Record<string, string> = {
  "Communication Services": "Comm. Services",
};

const RATIONALE_BOILERPLATE_RE = /^The sentiment for\b/i;

function formatWatchlistSector(sector: string | null): string {
  if (sector === null || sector.length === 0) {
    return "—";
  }
  return SECTOR_LABEL[sector] ?? sector;
}

function formatSentimentWithConfidence(
  sentiment: string | null,
  confidence: string | null,
): string {
  if (sentiment === null || sentiment.length === 0) {
    return "—";
  }
  const s = sentiment.toUpperCase();
  if (confidence === null || confidence.length === 0) {
    return s;
  }
  return `${s} ${confidence.toUpperCase()}`;
}

function formatWatchlistEarnings(earningsFlag: number | null, earningsDate: string | null): string {
  if (earningsFlag === 1 && earningsDate !== null && earningsDate.length > 0) {
    return `Earnings: ${earningsDate}`;
  }
  return "No earnings near";
}

function splitSentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
}

function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  const cut = text.slice(0, maxLen);
  const wordEnd = cut.lastIndexOf(" ");
  const base = wordEnd > maxLen * 0.5 ? cut.slice(0, wordEnd) : cut;
  return `${base.trim()}…`;
}

/** First non-boilerplate sentence, word-safe cap (avoids mid-word LLM chops). */
export function formatWatchlistRationale(rationale: string | null): string | null {
  if (rationale === null) {
    return null;
  }
  const trimmed = rationale.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const sentences = splitSentences(trimmed);
  // Take up to 3 non-boilerplate sentences for richer Telegram context.
  const nonBoiler = sentences.map((s) => s.trim()).filter((s) => s.length > 0 && !RATIONALE_BOILERPLATE_RE.test(s));
  const picked = nonBoiler.length > 0 ? nonBoiler.slice(0, 3).join(" ") : (sentences[0]?.trim() ?? "");
  if (picked.length === 0) {
    return null;
  }

  return truncateAtWord(picked, WATCHLIST_RATIONALE_MAX);
}

function formatWatchlistHeadLine(row: WatchlistBriefingRow): string {
  const ticker = row.ticker.padEnd(TICKER_COL_WIDTH).slice(0, TICKER_COL_WIDTH);
  const price = `$${row.price.toFixed(2)}`.padStart(PRICE_COL_WIDTH);
  const mom = row.momentum12_1Return.toFixed(2);
  const sentiment = formatSentimentWithConfidence(row.sentiment, row.confidence);
  const sector = formatWatchlistSector(row.sector);
  const earnings = formatWatchlistEarnings(row.earningsFlag, row.earningsDate);
  return `#${row.momentumRank}  ${ticker} ${price}  12-1: ${mom}  ${sentiment} | ${sector} | ${earnings}`;
}

/** Telegram "Next in Rank" bench — read-only context, not an entry signal. */
export function formatWatchlistBench(rows: readonly WatchlistBriefingRow[], asOf: string): string {
  const lines = [`📊 Next in Rank — ${asOf}`, ""];
  for (const row of rows) {
    lines.push(formatWatchlistHeadLine(row));
    const rationale = formatWatchlistRationale(row.rationale);
    if (rationale !== null) {
      lines.push(`  ${rationale}`);
    }
    lines.push("");
  }
  if (lines.length > 2 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  lines.push("", "ⓘ Watch context only — not an entry signal");
  let text = lines.join("\n");
  if (text.length > TG_MAX) {
    text = `${text.slice(0, TG_MAX - 20)}\n…(truncated)`;
  }
  return text;
}

export function renderHtml(payload: DashboardPayload): string {
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const atrTighten = DEFAULT_RANKING_CONFIG.atrTightenThresholdPct;
  const atrMultBase = DEFAULT_RANKING_CONFIG.atrMultiplierBase;
  const atrMultTight = DEFAULT_RANKING_CONFIG.atrMultiplierTight;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cue — Signal Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0d1117; --surface: #161b22; --border: #30363d;
      --text: #e6edf3; --muted: #8b949e;
      --green: #3fb950; --red: #f85149; --amber: #d29922;
      --accent: #58a6ff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; padding: 24px; }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 4px; }
    .meta { color: var(--muted); font-size: 12px; margin-bottom: 24px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge-green { background: rgba(63,185,80,.15); color: var(--green); border: 1px solid var(--green); }
    .badge-red   { background: rgba(248,81,73,.15);  color: var(--red);   border: 1px solid var(--red); }
    .badge-amber { background: rgba(210,153,34,.15); color: var(--amber); border: 1px solid var(--amber); }
    .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .card-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
    .card-value { font-size: 1.5rem; font-weight: 700; }
    .card-value.green { color: var(--green); }
    .card-value.red   { color: var(--red); }
    .card-value.amber { color: var(--amber); }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .rationale-cell { max-width: 420px; font-size: 12px; color: var(--muted); line-height: 1.5; word-break: break-word; }
    tr:last-child td { border-bottom: none; }
    .section-title { font-size: 1rem; font-weight: 600; margin: 24px 0 12px; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    canvas { max-height: 200px; }
    .ticker { font-weight: 700; color: var(--accent); }
    .stop { color: var(--red); }
    tr.regime-tight td { background: rgba(210,153,34,.12); }
  </style>
</head>
<body>
  <script>window.__CUE__ = ${json};</script>

  <h1>Cue — Nasdaq 100 Signal Engine</h1>
  <p class="meta" id="meta"></p>

  <div class="grid-4" id="kpi-row"></div>

  <h2 class="section-title">Open Positions</h2>
  <div class="card">
    <table id="positions-table">
      <thead><tr>
        <th>Ticker</th><th>Entry Date</th><th>Entry Price</th><th>Current Close</th>
        <th>High Since Entry</th>
        <th>Stop (dist %)</th><th>ATR regime</th>
        <th>Days Held (trading)</th><th>Momentum Rank</th><th>12-1 Return</th>
      </tr></thead>
      <tbody id="positions-body"></tbody>
    </table>
  </div>

  <h2 class="section-title">Live Performance</h2>
  <div class="card" id="live-perf-section"></div>

  <div class="two-col">
    <div>
      <h2 class="section-title">Recent Signals (Last 20)</h2>
      <div class="card">
        <table>
          <thead><tr>
            <th>Session Date</th><th>Alerted</th><th>Ticker</th><th>Type</th><th>Sector</th><th>Sentiment</th><th>Rationale</th>
          </tr></thead>
          <tbody id="signals-body"></tbody>
        </table>
      </div>
    </div>
    <div>
      <h2 class="section-title">Sector Allocation</h2>
      <div class="card"><canvas id="sector-chart"></canvas></div>
    </div>
  </div>

  <h2 class="section-title" id="backtest-section-title">Backtest (Latest Run)</h2>
  <div class="grid-4" id="backtest-row"></div>

  <script>
    const d = window.__CUE__;
    const ATR_TIGHTEN_PCT = ${atrTighten};
    const ATR_MULT_BASE = ${atrMultBase};
    const ATR_MULT_TIGHT = ${atrMultTight};
    function formatBacktestRef(bt) {
      if (!bt) {
        return '<p class="meta" style="margin-top:12px;margin-bottom:0">No momentum backtest on file.</p>';
      }
      const cagr = (bt.cagr * 100).toFixed(2);
      const sharpe = bt.sharpe.toFixed(2);
      const maxDd = (bt.max_drawdown * 100).toFixed(2);
      const exp = (bt.expectancy * 100).toFixed(2);
      const windowPart = bt.window_label ? ' · ' + bt.window_label : '';
      return '<p class="meta" style="margin-top:12px;margin-bottom:0"><strong>Backtest ref (' + bt.strategy + windowPart + ' · ' + bt.run_date + '):</strong><br>' +
        'CAGR ' + cagr + '% · Sharpe ' + sharpe + ' · MaxDD ' + maxDd + '% · Expectancy +' + exp + '%</p>';
    }

    // Meta
    document.getElementById('meta').innerHTML =
      'Generated: ' + new Date(d.generated_at).toLocaleString() +
      ' &nbsp;|&nbsp; Regime: ' +
      (d.regime_active
        ? '<span class="badge badge-green">BULLISH — QQQ &gt; SMA200</span>'
        : '<span class="badge badge-red">BEARISH — BUY SIGNALS SUPPRESSED</span>');

    // KPI row
    const kpis = [
      { label: 'Open Positions', value: d.open_positions.length, cls: '' },
      { label: 'Recent Signals (20d)', value: d.recent_signals.length, cls: '' },
      { label: 'Regime', value: d.regime_active ? 'BULLISH' : 'BEARISH', cls: d.regime_active ? 'green' : 'red' },
      { label: 'Sectors Held', value: d.sector_allocation.length, cls: '' },
    ];
    document.getElementById('kpi-row').innerHTML = kpis.map(k =>
      '<div class="card"><div class="card-label">' + k.label + '</div>' +
      '<div class="card-value ' + k.cls + '">' + k.value + '</div></div>'
    ).join('');

    // Positions table
    const pBody = document.getElementById('positions-body');
    if (d.open_positions.length === 0) {
      pBody.innerHTML = '<tr><td colspan="10" style="color:var(--muted);text-align:center">No open positions</td></tr>';
    } else {
      pBody.innerHTML = d.open_positions.map(p => {
        const unrealizedPct = ((p.current_close - p.entry_price) / p.entry_price) * 100;
        const distStopPct = ((p.current_stop_loss - p.current_close) / p.current_close) * 100;
        const tight = unrealizedPct >= ATR_TIGHTEN_PCT;
        const rowClass = tight ? 'regime-tight' : 'regime-base';
        const stopLabel = tight
          ? ('Tight (' + ATR_MULT_TIGHT + '× ATR)')
          : ('Base (' + ATR_MULT_BASE + '× ATR)');
        return (
          '<tr class="' + rowClass + '">' +
          '<td class="ticker">' + p.ticker + '</td>' +
          '<td>' + p.entry_date + '</td>' +
          '<td>$' + p.entry_price.toFixed(2) + '</td>' +
          '<td>$' + p.current_close.toFixed(2) + '</td>' +
          '<td>$' + p.highest_close_since_entry.toFixed(2) + '</td>' +
          '<td class="stop">$' + p.current_stop_loss.toFixed(2) +
            ' <span style="color:var(--muted);font-weight:500">(' + distStopPct.toFixed(2) + '%)</span></td>' +
          '<td><span class="badge ' + (tight ? 'badge-amber' : 'badge-green') + '">' + stopLabel + '</span></td>' +
          '<td>' + p.days_held + '</td>' +
          '<td>' + (p.momentum_rank == null ? '—' : ('#' + p.momentum_rank)) + '</td>' +
          '<td>' + (p.momentum_12_1_return == null ? '—' : ((p.momentum_12_1_return * 100).toFixed(1) + '%')) + '</td>' +
          '</tr>'
        );
      }).join('');
    }

    // Live Performance
    const lp = d.live_performance_summary;
    const lpConf = d.live_performance_by_confidence;
    const fmtPct = v => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
    const fmtPctPlain = v => v == null ? '—' : v.toFixed(2) + '%';
    const fmtWinRate = v => v == null ? '—' : v.toFixed(1) + '%';

    const btRef = d.backtest_summary;
    const btExpRef = btRef ? '+' + (btRef.expectancy * 100).toFixed(2) + '%' : '—';
    const btWinRef = btRef ? (btRef.win_rate * 100).toFixed(1) + '%' : '—';

    let livePerfHtml;
    if (lp.closed_trades === 0) {
      livePerfHtml =
        '<p style="color:var(--muted);margin:0">No strategy exits recorded yet.</p>' +
        formatBacktestRef(btRef);
    } else {
      livePerfHtml =
        '<h3 style="font-size:0.9rem;font-weight:600;margin:0 0 12px">Overall</h3>' +
        '<table><thead><tr><th>Metric</th><th>Live</th><th>Backtest (ref)</th></tr></thead><tbody>' +
        '<tr><td>Closed trades</td><td>' + lp.closed_trades + '</td><td>' + (btRef ? btRef.total_trades : '—') + '</td></tr>' +
        '<tr><td>Expectancy</td><td>' + fmtPct(lp.avg_pnl_pct) + '</td><td>' + btExpRef + '</td></tr>' +
        '<tr><td>Win rate</td><td>' + fmtWinRate(lp.win_rate_pct) + '</td><td>' + btWinRef + '</td></tr>' +
        '<tr><td>Worst trade</td><td>' + fmtPctPlain(lp.worst_trade_pct) + '</td><td>—</td></tr>' +
        '<tr><td>Best trade</td><td>' + fmtPctPlain(lp.best_trade_pct) + '</td><td>—</td></tr>' +
        '</tbody></table>';

      livePerfHtml += '<h3 style="font-size:0.9rem;font-weight:600;margin:20px 0 12px">P&amp;L by confidence tier</h3>';
      if (lpConf.length === 0) {
        livePerfHtml += '<p style="color:var(--muted)">No closed trades with recorded exit prices yet.</p>';
      } else {
        livePerfHtml += '<table><thead><tr><th>Confidence</th><th>Trades</th><th>Avg P&amp;L %</th></tr></thead><tbody>' +
          lpConf.map(r =>
            '<tr><td>' + r.confidence + '</td><td>' + r.trades + '</td><td>' + fmtPctPlain(r.avg_pnl_pct) + '</td></tr>'
          ).join('') +
          '</tbody></table>';
      }
      livePerfHtml += '<p class="meta" style="margin-top:16px;margin-bottom:0">Confidence tiers meaningful at ≥10 trades each.</p>';
    }
    document.getElementById('live-perf-section').innerHTML = livePerfHtml;

    // Signals table
    const sentimentColor = s => s === 'BULLISH' ? 'var(--green)' : s === 'BEARISH' ? 'var(--red)' : 'var(--amber)';
    const exitReasonLabel = r => ({ TRAILING_STOP: 'Trailing stop', REBALANCE_DROP: 'Rebalance drop', MAX_HOLD: 'Max hold', MANUAL: 'Manual' })[r] ?? (r ?? '—');
    document.getElementById('signals-body').innerHTML = d.recent_signals.map(s => {
      let sectorCell, sentimentCell, rationaleCell;
      if (s.signal_type === 'SELL') {
        const pnl = s.pnl_pct;
        const pnlStr = pnl == null ? '—' : (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
        const pnlColor = pnl == null ? 'var(--muted)' : pnl >= 0 ? 'var(--green)' : 'var(--red)';
        sectorCell = exitReasonLabel(s.exit_reason);
        sentimentCell = '<span style="color:' + pnlColor + ';font-weight:600">' + pnlStr + '</span>';
        rationaleCell = '';
      } else {
        const rat = s.rationale ?? '';
        sectorCell = s.sector ?? '—';
        sentimentCell = '<span style="color:' + sentimentColor(s.sentiment) + '">' + (s.sentiment ?? '—') + '</span>';
        if (s.enrichmentStatus !== 'OK') {
          rationaleCell = '<em style="color:var(--amber)">Enrichment unavailable (' + s.enrichmentStatus + ')</em>';
        } else {
          rationaleCell = rat.length === 0 ? '—'
            : '<span title="' + rat.replace(/"/g, '&quot;') + '" style="cursor:help">' + rat + '</span>';
        }
      }
      return (
        '<tr>' +
        '<td>' + s.signal_date + '</td>' +
        '<td style="color:var(--muted);font-size:12px">' + (s.alerted_at ? s.alerted_at.slice(0, 10) : '—') + '</td>' +
        '<td class="ticker">' + s.ticker + '</td>' +
        '<td><span class="badge ' + (s.signal_type === 'BUY' ? 'badge-green' : 'badge-red') + '">' + s.signal_type + '</span></td>' +
        '<td>' + sectorCell + '</td>' +
        '<td>' + sentimentCell + '</td>' +
        '<td class="rationale-cell">' + rationaleCell + '</td>' +
        '</tr>'
      );
    }).join('');

    // Sector doughnut
    if (d.sector_allocation.length > 0) {
      new Chart(document.getElementById('sector-chart'), {
        type: 'doughnut',
        data: {
          labels: d.sector_allocation.map(x => x.sector),
          datasets: [{ data: d.sector_allocation.map(x => x.count),
            backgroundColor: ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#79c0ff','#56d364'] }]
        },
        options: { plugins: { legend: { labels: { color: '#e6edf3', font: { size: 11 } } } } }
      });
    } else {
      document.getElementById('sector-chart').parentElement.innerHTML =
        '<p style="color:var(--muted);text-align:center;padding:40px 0">No sector data for open positions</p>';
    }

    // Backtest KPIs
    const bt = d.backtest_summary;
    if (bt) {
      document.getElementById('backtest-section-title').textContent =
        'Backtest (' + bt.strategy + ' · ' + bt.run_date + ')';
    }
    const btKpis = bt ? [
      { label: 'CAGR',         value: (bt.cagr * 100).toFixed(2) + '%',         cls: bt.cagr > 0.12 ? 'green' : 'red' },
      { label: 'Sharpe',       value: bt.sharpe.toFixed(3),                      cls: bt.sharpe > 1.0 ? 'green' : 'red' },
      { label: 'Max Drawdown', value: (bt.max_drawdown * 100).toFixed(2) + '%',  cls: bt.max_drawdown < 0.20 ? 'green' : 'red' },
      { label: 'Expectancy',   value: (bt.expectancy * 100).toFixed(2) + '%',    cls: bt.expectancy > 0 ? 'green' : 'red' },
    ] : [{ label: 'Backtest', value: 'No data', cls: 'amber' }];
    document.getElementById('backtest-row').innerHTML = btKpis.map(k =>
      '<div class="card"><div class="card-label">' + k.label + '</div>' +
      '<div class="card-value ' + k.cls + '">' + k.value + '</div></div>'
    ).join('');
  </script>
</body>
</html>`;
}
