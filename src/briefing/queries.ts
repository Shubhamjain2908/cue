import { getConfig } from "../config/index.js";
import { openCueDbReadonly, type CueDatabase } from "../db/provider.js";
import { addCalendarDays } from "../shared/date-utils.js";
import { loadQqqTradingDates } from "../shared/market-data-utils.js";

export type RegimeLabel = "BULLISH" | "BEARISH";

export interface OpenPositionPulseRow {
  ticker: string;
  entry_price: number;
  current_stop_loss: number;
  last_close: number | null;
  atr14: number | null;
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
 * Nearest future Saturday on the ET civil calendar (rebalance session day).
 * If `etToday` is Saturday, returns the following Saturday (+7 days).
 */
export function computeNextRebalanceFriday(etToday: string): string {
  const dow = weekdayForEtYmd(etToday);
  if (dow === 6) {
    return addCalendarDays(etToday, 7);
  }
  const daysUntil = (6 - dow + 7) % 7;
  return addCalendarDays(etToday, daysUntil);
}

/** Count QQQ sessions strictly after `fromExclusive` through `asOfInclusive`. */
function countQqqTradingSessionsAfter(
  sortedTradingDates: readonly string[],
  fromExclusive: string,
  asOfInclusive: string,
): number {
  let count = 0;
  for (const d of sortedTradingDates) {
    if (d <= fromExclusive) {
      continue;
    }
    if (d > asOfInclusive) {
      break;
    }
    count++;
  }
  return count;
}

export interface StaleOpenPositionRow {
  ticker: string;
  lastPriceDate: string | null;
  /** QQQ sessions between last bar and `asOf` (exclusive of last bar date). */
  sessionsBehind: number;
}

const STALE_OPEN_POSITION_SESSION_THRESHOLD = 3;

/**
 * OPEN positions whose latest `daily_prices` bar is more than three QQQ sessions
 * behind `asOf` (orphaned price feed / missing vendor bar).
 */
export function getStaleOpenPositions(db: CueDatabase, asOf: string): StaleOpenPositionRow[] {
  const rows = db
    .prepare(
      `
      SELECT sig.ticker AS ticker, MAX(dp.date) AS lastPriceDate
      FROM positions p
      INNER JOIN signals sig ON sig.id = p.signal_id
      LEFT JOIN daily_prices dp ON dp.ticker = sig.ticker
      WHERE p.status = 'OPEN'
      GROUP BY sig.ticker
      ORDER BY sig.ticker ASC
    `,
    )
    .all() as { ticker: string; lastPriceDate: string | null }[];

  if (rows.length === 0) {
    return [];
  }

  const calendarFrom = addCalendarDays(asOf, -400);
  const sortedTradingDates = loadQqqTradingDates(db, calendarFrom, asOf);
  const stale: StaleOpenPositionRow[] = [];

  for (const row of rows) {
    if (row.lastPriceDate === null) {
      stale.push({ ticker: row.ticker, lastPriceDate: null, sessionsBehind: 999 });
      continue;
    }
    const sessionsBehind = countQqqTradingSessionsAfter(
      sortedTradingDates,
      row.lastPriceDate,
      asOf,
    );
    if (sessionsBehind > STALE_OPEN_POSITION_SESSION_THRESHOLD) {
      stale.push({
        ticker: row.ticker,
        lastPriceDate: row.lastPriceDate,
        sessionsBehind,
      });
    }
  }

  return stale;
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
  enrichmentStatus: string;
}

/** SELL signal row for Telegram exit alerts. */
export interface SellAlertPendingRow {
  id: number;
  ticker: string;
  exitDate: string;
  exitPrice: number;
  entryDate: string;
  entryPrice: number;
  exitReason: string | null;
}

/**
 * SELL signals not yet alerted, joined to the closed position for entry context.
 * Matches via `positions.exit_date = signals.date` + ticker cross-check through the BUY signal FK.
 */
export function listSellSignalsReadyToAlert(db: CueDatabase): SellAlertPendingRow[] {
  return db
    .prepare(
      `
      SELECT
        s.id          AS id,
        s.ticker      AS ticker,
        s.date        AS exitDate,
        s.price       AS exitPrice,
        p.entry_date  AS entryDate,
        p.entry_price AS entryPrice,
        p.exit_reason AS exitReason
      FROM signals s
      INNER JOIN positions p ON p.exit_date = s.date
      INNER JOIN signals buy_sig ON buy_sig.id = p.signal_id AND buy_sig.ticker = s.ticker
      WHERE s.signal = 'SELL'
        AND (s.alerted = 0 OR s.alerted IS NULL)
        AND p.exit_date > p.entry_date
      ORDER BY s.date ASC, s.ticker ASC
    `,
    )
    .all() as SellAlertPendingRow[];
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
      e.confidence AS confidence,
      COALESCE(e.status, 'OK') AS enrichmentStatus
    FROM signals s
    LEFT JOIN enrichments e ON e.signal_id = s.id
    WHERE s.signal = 'BUY' AND s.alerted = 0
    ORDER BY s.date ASC, s.ticker ASC
  `);
  return stmt.all() as BuyAlertPendingRow[];
}

/** WATCHLIST bench row for Telegram "Next in Rank" message. */
export interface WatchlistBriefingRow {
  id: number;
  ticker: string;
  momentumRank: number;
  price: number;
  atr14: number | null;
  momentum12_1Return: number;
  sentiment: string | null;
  confidence: string | null;
  sector: string | null;
  rationale: string | null;
  earningsFlag: number | null;
  earningsDate: string | null;
}

/** Unalerted WATCHLIST rows for session `asOf`, with optional enrichment join. */
export function listWatchlistSignalsForBriefing(
  db: CueDatabase,
  asOf: string,
  limit: number,
): WatchlistBriefingRow[] {
  if (limit <= 0) {
    return [];
  }
  const stmt = db.prepare(`
    SELECT
      s.id AS id,
      s.ticker AS ticker,
      s.momentum_rank AS momentumRank,
      s.price AS price,
      s.atr14 AS atr14,
      s.momentum_12_1_return AS momentum12_1Return,
      e.sentiment AS sentiment,
      e.confidence AS confidence,
      e.sector AS sector,
      e.rationale AS rationale,
      e.earnings_flag AS earningsFlag,
      e.earnings_date AS earningsDate
    FROM signals s
    LEFT JOIN enrichments e ON e.signal_id = s.id
    WHERE s.signal = 'WATCHLIST'
      AND s.date = @asOf
      AND s.alerted = 0
    ORDER BY s.momentum_rank ASC
    LIMIT @limit
  `);
  return stmt.all({ asOf, limit }) as WatchlistBriefingRow[];
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
  /** Rank at time of BUY signal entry (from `signals.momentum_rank`). */
  momentum_rank: number | null;
  /** Rank from the most recent rebalance (from `positions.current_rank`). Updated every Sunday. */
  current_rank: number | null;
  momentum_12_1_return: number | null;
  atr14: number | null;
  days_held: number;
}

export interface RecentSignal {
  ticker: string;
  signal_type: "BUY" | "SELL";
  signal_date: string;
  /** ISO timestamp when the Telegram alert was sent (null if not yet alerted). */
  alerted_at: string | null;
  momentum_rank: number | null;
  momentum_12_1_return: number | null;
  sentiment: string | null;
  rationale: string | null;
  sector: string | null;
  enrichmentStatus: string;
  /** Populated for SELL rows only: reason the position was closed. */
  exit_reason: string | null;
  /** Populated for SELL rows only: realised P&L % vs entry price. */
  pnl_pct: number | null;
}

export interface BacktestSummary {
  run_date: string;
  strategy: string;
  window_label: string | null;
  cagr: number;
  sharpe: number;
  max_drawdown: number;
  expectancy: number;
  win_rate: number;
  total_trades: number;
}

interface BacktestRow {
  run_date: string;
  strategy: string;
  window_label: string | null;
  cagr: number;
  sharpe_ratio: number;
  max_drawdown: number;
  expectancy: number;
  win_rate: number;
  total_trades: number;
}

/** Latest locked momentum backtest run for dashboard reference metrics. */
export function getMomentumBacktestSummary(db: CueDatabase): BacktestSummary | null {
  const raw = db
    .prepare(
      `
      SELECT run_date, strategy, window_label, cagr, sharpe_ratio, max_drawdown, expectancy, win_rate, total_trades
      FROM backtest_runs
      WHERE strategy = 'MOMENTUM' AND locked = 1
      ORDER BY run_date DESC
      LIMIT 1
    `,
    )
    .get() as BacktestRow | undefined;

  if (!raw) {
    return null;
  }

  return {
    run_date: raw.run_date,
    strategy: raw.strategy,
    window_label: raw.window_label,
    cagr: raw.cagr / 100,
    sharpe: raw.sharpe_ratio,
    max_drawdown: raw.max_drawdown / 100,
    expectancy: raw.expectancy / 100,
    win_rate: raw.win_rate / 100,
    total_trades: raw.total_trades,
  };
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
        AND exit_reason != 'MANUAL'
        AND exit_date > entry_date
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
        AND p.exit_reason != 'MANUAL'
        AND p.exit_date > p.entry_date
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

interface RegimeRow {
  regime_active: number;
}

/**
 * Read-only snapshot of SQLite for dashboard embedding.
 * Column names follow UI contracts; `cagr` / `max_drawdown` / `expectancy` are **decimals** (e.g. 0.2139 = 21.39%).
 */
export function extractDashboardPayloadFromDb(db: CueDatabase): DashboardPayload {
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
        p.current_rank AS current_rank,
        sig.momentum_rank AS momentum_rank,
        sig.momentum_12_1_return AS momentum_12_1_return,
        sig.atr14 AS atr14,
        (
          SELECT COUNT(*)
          FROM daily_prices dp_held
          WHERE dp_held.ticker = sig.ticker
            AND dp_held.date > p.entry_date
        ) AS days_held
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
        s.alerted_at AS alerted_at,
        s.momentum_rank AS momentum_rank,
        s.momentum_12_1_return AS momentum_12_1_return,
        e.sentiment AS sentiment,
        e.rationale AS rationale,
        e.sector AS sector,
        COALESCE(e.status, 'OK') AS enrichmentStatus,
        closed.exit_reason AS exit_reason,
        CASE
          WHEN closed.entry_price IS NOT NULL AND closed.entry_price > 0
          THEN ROUND((s.price - closed.entry_price) / closed.entry_price * 100, 2)
          ELSE NULL
        END AS pnl_pct
      FROM signals s
      LEFT JOIN enrichments e ON e.signal_id = s.id
      LEFT JOIN (
        SELECT p.exit_date, p.exit_reason, p.entry_price, bs.ticker
        FROM positions p
        JOIN signals bs ON bs.id = p.signal_id
        WHERE p.status != 'OPEN'
      ) closed ON s.signal = 'SELL' AND closed.ticker = s.ticker AND closed.exit_date = s.date
      WHERE s.signal IN ('BUY', 'SELL')
      ORDER BY s.date DESC
      LIMIT 20
    `,
      )
      .all() as RecentSignal[];

    const backtest_summary = getMomentumBacktestSummary(db);

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
}

export function extractDashboardPayload(): DashboardPayload {
  const { DB_PATH } = getConfig();
  const db = openCueDbReadonly(DB_PATH);

  try {
    return extractDashboardPayloadFromDb(db);
  } finally {
    db.close();
  }
}
