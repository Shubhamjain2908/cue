import { getConfig } from "../config/index.js";
import { openCueDbReadonly, type CueDatabase } from "../db/provider.js";

export type RegimeLabel = "BULLISH" | "BEARISH";

export interface OpenPositionPulseRow {
  ticker: string;
  entry_price: number;
  current_stop_loss: number;
  last_close: number | null;
  atr14: number | null;
}

function parseIsoUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function addCalendarDays(iso: string, days: number): string {
  const ms = parseIsoUtcMs(iso) + days * 86_400_000;
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const da = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** Gregorian weekday for an America/New_York calendar date (0 Sunday … 6 Saturday). */
function weekdayForEtYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0)).getUTCDay();
}

/** Latest QQQ session in DB (screen / pulse as-of). */
export function resolvePulseAsOfDate(db: CueDatabase): string | null {
  const row = db
    .prepare(`SELECT MAX(date) AS d FROM daily_prices WHERE ticker = 'QQQ'`)
    .get() as { d: string | null };
  return row.d;
}

/** QQQ close vs SMA(200) — same logic as dashboard regime query. */
export function getRegimeLabel(db: CueDatabase): RegimeLabel {
  const regimeRow = db
    .prepare(
      `
      WITH qqq_prices AS (
        SELECT date, close
        FROM daily_prices
        WHERE ticker = 'QQQ'
        ORDER BY date DESC
        LIMIT 200
      ),
      latest AS (SELECT close FROM qqq_prices LIMIT 1),
      sma AS (SELECT AVG(close) AS sma200 FROM qqq_prices)
      SELECT CASE
        WHEN (SELECT close FROM latest) > (SELECT sma200 FROM sma) THEN 1
        ELSE 0
      END AS regime_active
    `,
    )
    .get() as { regime_active: number } | undefined;
  return (regimeRow?.regime_active ?? 0) === 1 ? "BULLISH" : "BEARISH";
}

/**
 * Nearest future Friday on the ET civil calendar.
 * If `etToday` is Friday, returns the following Friday (+7 days).
 */
export function computeNextRebalanceFriday(etToday: string): string {
  const dow = weekdayForEtYmd(etToday);
  if (dow === 5) {
    return addCalendarDays(etToday, 7);
  }
  const daysUntil = (5 - dow + 7) % 7;
  return addCalendarDays(etToday, daysUntil);
}

/** OPEN positions with `daily_prices.close` on `asOf` (null when bar missing). */
export function getOpenPositionsWithLastClose(
  db: CueDatabase,
  asOf: string,
): OpenPositionPulseRow[] {
  return db
    .prepare(
      `
      SELECT
        sig.ticker AS ticker,
        p.entry_price AS entry_price,
        COALESCE(p.current_stop_loss, sig.initial_atr_stop) AS current_stop_loss,
        dp.close AS last_close,
        sig.atr14 AS atr14
      FROM positions p
      INNER JOIN signals sig ON sig.id = p.signal_id
      LEFT JOIN daily_prices dp ON dp.ticker = sig.ticker AND dp.date = @asOf
      WHERE p.status = 'OPEN'
      ORDER BY sig.ticker ASC
    `,
    )
    .all({ asOf }) as OpenPositionPulseRow[];
}

/** BUY signal row for Telegram alerts (enrichment optional). */
export interface BuyAlertPendingRow {
  id: number;
  ticker: string;
  date: string;
  signal: "BUY" | "SELL";
  price: number;
  alerted: number;
  momentumRank: number;
  universeRankedCount: number;
  momentum12_1Return: number;
  atr14: number;
  initialAtrStop: number;
  sentiment: string | null;
  rationale: string | null;
  earningsDate: string | null;
  sector: string | null;
  confidence: string | null;
}

/** BUY rows not yet Telegram-alerted; enrichments joined when present. */
export function listBuySignalsReadyToAlert(db: CueDatabase): BuyAlertPendingRow[] {
  const stmt = db.prepare(`
    SELECT
      s.id AS id,
      s.ticker AS ticker,
      s.date AS date,
      s.signal AS signal,
      s.price AS price,
      s.alerted AS alerted,
      s.momentum_rank AS momentumRank,
      s.universe_ranked_count AS universeRankedCount,
      s.momentum_12_1_return AS momentum12_1Return,
      s.atr14 AS atr14,
      s.initial_atr_stop AS initialAtrStop,
      e.sentiment AS sentiment,
      e.rationale AS rationale,
      e.earnings_date AS earningsDate,
      e.sector AS sector,
      e.confidence AS confidence
    FROM signals s
    LEFT JOIN enrichments e ON e.signal_id = s.id
    WHERE s.signal = 'BUY' AND s.alerted = 0
    ORDER BY s.date ASC, s.ticker ASC
  `);
  return stmt.all() as BuyAlertPendingRow[];
}

export interface OpenPosition {
  ticker: string;
  entry_date: string;
  entry_price: number;
  /** Trailing floor from ledger (`positions.current_stop_loss`), backfilled from signal when absent. */
  current_stop_loss: number;
  /** High-water close from ledger (`positions.highest_close_since_entry`), else replayed from prices. */
  highest_close_since_entry: number;
  /** Latest daily close (`daily_prices`) for stop-distance / regime display. */
  current_close: number;
  momentum_rank: number | null;
  momentum_12_1_return: number | null;
  atr14: number | null;
  days_held: number;
}

export interface RecentSignal {
  ticker: string;
  signal_type: "BUY" | "SELL";
  signal_date: string;
  momentum_rank: number | null;
  momentum_12_1_return: number | null;
  sentiment: string | null;
  rationale: string | null;
  sector: string | null;
}

export interface BacktestSummary {
  run_date: string;
  cagr: number;
  sharpe: number;
  max_drawdown: number;
  expectancy: number;
  total_trades: number;
}

export interface LivePerformanceSummary {
  closed_trades: number;
  avg_pnl_pct: number | null;
  win_rate_pct: number | null;
  worst_trade_pct: number | null;
  best_trade_pct: number | null;
}

export interface LivePerformanceByConfidenceRow {
  confidence: string;
  trades: number;
  avg_pnl_pct: number;
}

const EMPTY_LIVE_PERFORMANCE_SUMMARY: LivePerformanceSummary = {
  closed_trades: 0,
  avg_pnl_pct: null,
  win_rate_pct: null,
  worst_trade_pct: null,
  best_trade_pct: null,
};

/** Closed live trades with valid exit prices — overall P&L stats. */
export function getLivePerformanceSummary(db: CueDatabase): LivePerformanceSummary {
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS closed_trades,
        ROUND(AVG((exit_price - entry_price) / entry_price * 100), 2) AS avg_pnl_pct,
        ROUND(100.0 * SUM(CASE WHEN exit_price > entry_price THEN 1 ELSE 0 END)
              / COUNT(*), 1) AS win_rate_pct,
        ROUND(MIN((exit_price - entry_price) / entry_price * 100), 2) AS worst_trade_pct,
        ROUND(MAX((exit_price - entry_price) / entry_price * 100), 2) AS best_trade_pct
      FROM positions
      WHERE status != 'OPEN'
        AND exit_price IS NOT NULL
        AND exit_price > 0
        AND exit_reason NOT IN ('MANUAL', 'REBALANCE_DROP')
    `,
    )
    .get() as LivePerformanceSummary | undefined;

  if (!row || row.closed_trades === 0) {
    return EMPTY_LIVE_PERFORMANCE_SUMMARY;
  }
  return row;
}

/** Closed live trades with valid exit prices — avg P&L by LLM confidence tier. */
export function getLivePerformanceByConfidence(db: CueDatabase): LivePerformanceByConfidenceRow[] {
  return db
    .prepare(
      `
      SELECT e.confidence,
             COUNT(*) AS trades,
             ROUND(AVG((p.exit_price - p.entry_price) / p.entry_price * 100), 2) AS avg_pnl_pct
      FROM positions p
      JOIN signals s ON s.id = p.signal_id
      JOIN enrichments e ON e.signal_id = s.id
      WHERE p.status != 'OPEN'
        AND p.exit_price IS NOT NULL
        AND p.exit_price > 0
        AND p.exit_reason NOT IN ('MANUAL', 'REBALANCE_DROP')
      GROUP BY e.confidence
      ORDER BY avg_pnl_pct DESC
    `,
    )
    .all() as LivePerformanceByConfidenceRow[];
}

export interface DashboardPayload {
  generated_at: string;
  regime_active: boolean;
  open_positions: OpenPosition[];
  recent_signals: RecentSignal[];
  backtest_summary: BacktestSummary | null;
  sector_allocation: { sector: string; count: number }[];
  live_performance_summary: LivePerformanceSummary;
  live_performance_by_confidence: LivePerformanceByConfidenceRow[];
}

interface BacktestRow {
  run_date: string;
  cagr: number;
  sharpe_ratio: number;
  max_drawdown: number;
  expectancy: number;
  total_trades: number;
}

interface RegimeRow {
  regime_active: number;
}

/**
 * Read-only snapshot of SQLite for dashboard embedding.
 * Column names follow UI contracts; `cagr` / `max_drawdown` / `expectancy` are **decimals** (e.g. 0.2139 = 21.39%).
 */
export function extractDashboardPayload(): DashboardPayload {
  const { DB_PATH } = getConfig();
  const db = openCueDbReadonly(DB_PATH);

  try {
    const open_positions = db
      .prepare(
        `
      SELECT
        sig.ticker AS ticker,
        p.entry_date AS entry_date,
        p.entry_price AS entry_price,
        COALESCE(p.current_stop_loss, sig.initial_atr_stop) AS current_stop_loss,
        COALESCE(
          p.highest_close_since_entry,
          (
            SELECT MAX(dp2.close)
            FROM daily_prices dp2
            WHERE dp2.ticker = sig.ticker AND dp2.date >= p.entry_date
          ),
          p.entry_price
        ) AS highest_close_since_entry,
        COALESCE(
          dp.close,
          (
            SELECT dp3.close
            FROM daily_prices dp3
            WHERE dp3.ticker = sig.ticker
            ORDER BY dp3.date DESC
            LIMIT 1
          ),
          p.entry_price
        ) AS current_close,
        sig.momentum_rank AS momentum_rank,
        sig.momentum_12_1_return AS momentum_12_1_return,
        sig.atr14 AS atr14,
        CAST(julianday('now') - julianday(p.entry_date) AS INTEGER) AS days_held
      FROM positions p
      INNER JOIN signals sig ON sig.id = p.signal_id
      LEFT JOIN daily_prices dp ON dp.ticker = sig.ticker
        AND dp.date = (
          SELECT MAX(dpx.date)
          FROM daily_prices dpx
          WHERE dpx.ticker = sig.ticker
        )
      WHERE p.status = 'OPEN'
      ORDER BY p.entry_date ASC
    `,
      )
      .all() as OpenPosition[];

    const recent_signals = db
      .prepare(
        `
      SELECT
        s.ticker AS ticker,
        s.signal AS signal_type,
        s.date AS signal_date,
        s.momentum_rank AS momentum_rank,
        s.momentum_12_1_return AS momentum_12_1_return,
        e.sentiment AS sentiment,
        e.rationale AS rationale,
        e.sector AS sector
      FROM signals s
      LEFT JOIN enrichments e ON e.signal_id = s.id
      WHERE s.signal IN ('BUY', 'SELL')
      ORDER BY s.date DESC
      LIMIT 20
    `,
      )
      .all() as RecentSignal[];

    const rawBacktest = db
      .prepare(
        `
      SELECT run_date, cagr, sharpe_ratio, max_drawdown, expectancy, total_trades
      FROM backtest_runs
      ORDER BY run_date DESC
      LIMIT 1
    `,
      )
      .get() as BacktestRow | undefined;

    let backtest_summary: BacktestSummary | null = null;
    if (rawBacktest) {
      backtest_summary = {
        run_date: rawBacktest.run_date,
        cagr: rawBacktest.cagr / 100,
        sharpe: rawBacktest.sharpe_ratio,
        max_drawdown: rawBacktest.max_drawdown / 100,
        expectancy: rawBacktest.expectancy / 100,
        total_trades: rawBacktest.total_trades,
      };
    }

    const regimeRow = db
      .prepare(
        `
      WITH qqq_prices AS (
        SELECT date, close
        FROM daily_prices
        WHERE ticker = 'QQQ'
        ORDER BY date DESC
        LIMIT 200
      ),
      latest AS (SELECT close FROM qqq_prices LIMIT 1),
      sma AS (SELECT AVG(close) AS sma200 FROM qqq_prices)
      SELECT CASE
        WHEN (SELECT close FROM latest) > (SELECT sma200 FROM sma) THEN 1
        ELSE 0
      END AS regime_active
    `,
      )
      .get() as RegimeRow | undefined;

    const sector_allocation = db
      .prepare(
        `
      SELECT e.sector AS sector, COUNT(*) AS count
      FROM positions p
      INNER JOIN signals sig ON sig.id = p.signal_id
      INNER JOIN enrichments e ON e.signal_id = sig.id
      WHERE p.status = 'OPEN' AND e.sector IS NOT NULL AND e.sector != ''
      GROUP BY e.sector
      ORDER BY count DESC
    `,
      )
      .all() as { sector: string; count: number }[];

    return {
      generated_at: new Date().toISOString(),
      regime_active: (regimeRow?.regime_active ?? 0) === 1,
      open_positions,
      recent_signals,
      backtest_summary,
      sector_allocation,
      live_performance_summary: getLivePerformanceSummary(db),
      live_performance_by_confidence: getLivePerformanceByConfidence(db),
    };
  } finally {
    db.close();
  }
}
