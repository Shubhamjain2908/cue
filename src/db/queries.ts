import Database from "better-sqlite3";

import { cueLogger } from "../cli/cue-logger.js";
import { getConfig } from "../config/index.js";
import { openCueDb } from "./provider.js";

type SqliteConnection = InstanceType<typeof Database>;

/** `prepare` typings default to a single-arg `run` when SQL does not carry inferred bind shapes. */
type FundamentalsUpsertStatement = {
  run(ticker: string, asOfDate: string, payloadJson: string): {
    changes: number;
    lastInsertRowid: number | bigint;
  };
};

let fundamentalsDb: SqliteConnection | null = null;

function getDbHandleForFundamentals(): SqliteConnection {
  if (!fundamentalsDb) {
    fundamentalsDb = openCueDb(getConfig().DB_PATH);
  }
  return fundamentalsDb;
}

let upsertFundamentalsStmt: FundamentalsUpsertStatement | null = null;

/**
 * Idempotent upsert into `fundamentals_cache` (unique on `ticker`, `as_of_date`).
 * Uses a module-scoped prepared statement and shared DB handle from config `DB_PATH`.
 */
export function upsertFundamentalsCache(ticker: string, asOfDate: string, payloadJson: string): void {
  if (!upsertFundamentalsStmt) {
    const db = getDbHandleForFundamentals();
    upsertFundamentalsStmt = db.prepare(`
      INSERT INTO fundamentals_cache (ticker, as_of_date, payload_json, fetched_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(ticker, as_of_date) DO UPDATE SET
        payload_json = excluded.payload_json,
        fetched_at = CURRENT_TIMESTAMP
    `) as FundamentalsUpsertStatement;
  }
  upsertFundamentalsStmt.run(ticker.toUpperCase(), asOfDate, payloadJson);
}

export type SignalSide = "BUY" | "SELL" | "HOLD" | "WATCHLIST";

export type PositionStatus = "OPEN" | "CLOSED";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export interface SignalInsert {
  ticker: string;
  date: string;
  signal: SignalSide;
  /** Strategy lane; default MOMENTUM. */
  signalType?: string | null;
  price: number;
  /** Rank within momentum universe (1 = strongest). Required for BUY. */
  momentumRank?: number | null;
  universeRankedCount?: number | null;
  /**
   * Raw fraction as returned by `rankUniverse()` (`momentumReturn`). Not a percent at rest —
   * multiply by 100 only in prompts/UI.
   */
  momentum12_1Return?: number | null;
  atr14?: number | null;
  initialAtrStop?: number | null;
}

export interface PositionInsert {
  signalId: number;
  entryDate: string;
  entryPrice: number;
  status: PositionStatus;
}

export interface DailyPriceInsert {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EnrichmentInsert {
  signalId: number;
  sentiment: string;
  rationale: string;
  earningsFlag: number;
  earningsDate: string | null;
  sector: string | null;
  sectorTrend: string | null;
  headlines: string;
  confidence: ConfidenceLevel;
}

export interface BuySignalForEnrichmentRow {
  id: number;
  ticker: string;
  date: string;
  signal: SignalSide;
  price: number;
  alerted: number;
  momentumRank: number;
  universeRankedCount: number;
  momentum12_1Return: number;
  atr14: number;
  initialAtrStop: number | null;
}

/** BUY + enrichment for Telegram (one row per signal). */
export interface BuyAlertPendingRow extends BuySignalForEnrichmentRow {
  sentiment: string;
  rationale: string;
  earningsDate: string | null;
  sector: string | null;
  confidence: ConfidenceLevel;
  enrichmentStatus: string;
}

export type EnrichmentStatus = "OK" | "LLM_FAIL" | "TIMEOUT" | "SCHEMA_FAIL" | "YAHOO_FAIL";

export interface EnrichmentRow {
  id: number;
  signalId: number;
  status: EnrichmentStatus;
  sentiment: string;
  rationale: string;
  earningsFlag: number;
  earningsDate: string | null;
  sector: string | null;
  sectorTrend: string | null;
  headlines: string;
  confidence: ConfidenceLevel;
}

/**
 * Inserts daily OHLCV rows for one ticker. Uses a single transaction and
 * `INSERT OR IGNORE` so duplicate (ticker, date) pairs are skipped safely.
 */
export function insertDailyPrices(
  db: SqliteConnection,
  ticker: string,
  bars: DailyPriceInsert[],
): void {
  if (bars.length === 0) {
    return;
  }
  const upper = ticker.toUpperCase();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO daily_prices (ticker, date, open, high, low, close, volume)
    VALUES (@ticker, @date, @open, @high, @low, @close, @volume)
  `);
  const runAll = db.transaction((rows: DailyPriceInsert[]) => {
    for (const bar of rows) {
      stmt.run({
        ticker: upper,
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
    }
  });
  runAll(bars);
}

function requireBuyMomentum(row: SignalInsert): void {
  if (row.signal !== "BUY") {
    return;
  }
  const fields: Array<[string, unknown]> = [
    ["momentumRank", row.momentumRank],
    ["universeRankedCount", row.universeRankedCount],
    ["momentum12_1Return", row.momentum12_1Return],
    ["atr14", row.atr14],
    ["initialAtrStop", row.initialAtrStop],
  ];
  for (const [name, v] of fields) {
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) {
      throw new Error(`BUY signal requires non-null ${name} (denormalized momentum context)`);
    }
  }
}

function requireWatchlistMomentum(row: SignalInsert): void {
  if (row.signal !== "WATCHLIST") {
    return;
  }
  const fields: Array<[string, unknown]> = [
    ["momentumRank", row.momentumRank],
    ["universeRankedCount", row.universeRankedCount],
    ["momentum12_1Return", row.momentum12_1Return],
    ["atr14", row.atr14],
  ];
  for (const [name, v] of fields) {
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) {
      throw new Error(`WATCHLIST signal requires non-null ${name} (denormalized momentum context)`);
    }
  }
}

export function insertSignal(
  db: SqliteConnection,
  row: SignalInsert,
): { changes: number; lastInsertRowid: bigint } {
  requireBuyMomentum(row);
  requireWatchlistMomentum(row);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO signals (
      ticker, date, signal, signal_type, price, alerted,
      momentum_rank, universe_ranked_count, momentum_12_1_return, atr14, initial_atr_stop
    ) VALUES (
      @ticker, @date, @signal, @signalType, @price, 0,
      @momentumRank, @universeRankedCount, @momentum12_1Return, @atr14, @initialAtrStop
    )
  `);
  const info = stmt.run({
    ticker: row.ticker,
    date: row.date,
    signal: row.signal,
    signalType: row.signalType ?? "MOMENTUM",
    price: row.price,
    momentumRank: row.momentumRank ?? null,
    universeRankedCount: row.universeRankedCount ?? null,
    momentum12_1Return: row.momentum12_1Return ?? null,
    atr14: row.atr14 ?? null,
    initialAtrStop: row.initialAtrStop ?? null,
  });
  if (info.changes === 0) {
    cueLogger.warn(
      `insertSignal: no-op (UNIQUE collision) ticker=${row.ticker} ` +
        `date=${row.date} signal=${row.signal} ` +
        `signalType=${row.signalType ?? "MOMENTUM"}`,
    );
  }
  return { changes: info.changes, lastInsertRowid: BigInt(info.lastInsertRowid) };
}

export function listUnenrichedBuySignals(db: SqliteConnection): Array<{
  id: number;
  ticker: string;
  date: string;
}> {
  const stmt = db.prepare(`
    SELECT s.id AS id, s.ticker AS ticker, s.date AS date
    FROM signals s
    LEFT JOIN enrichments e ON e.signal_id = s.id
    WHERE s.signal = 'BUY' AND e.id IS NULL
    ORDER BY s.date ASC, s.ticker ASC
  `);
  return stmt.all() as Array<{ id: number; ticker: string; date: string }>;
}

export function listUnenrichedWatchlistSignals(db: SqliteConnection): Array<{
  id: number;
  ticker: string;
  date: string;
}> {
  const stmt = db.prepare(`
    SELECT s.id AS id, s.ticker AS ticker, s.date AS date
    FROM signals s
    LEFT JOIN enrichments e ON e.signal_id = s.id
    WHERE s.signal = 'WATCHLIST' AND e.id IS NULL
    ORDER BY s.date ASC, s.momentum_rank ASC
  `);
  return stmt.all() as Array<{ id: number; ticker: string; date: string }>;
}

/** BUY rows with enrichment persisted and not yet Telegram-alerted. */
export function listBuySignalsReadyToAlert(db: SqliteConnection): BuyAlertPendingRow[] {
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

export function getBuySignalForEnrichment(
  db: SqliteConnection,
  signalId: number,
): BuySignalForEnrichmentRow | undefined {
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
      s.initial_atr_stop AS initialAtrStop
    FROM signals s
    WHERE s.id = @id AND s.signal IN ('BUY', 'WATCHLIST')
  `);
  return stmt.get({ id: signalId }) as BuySignalForEnrichmentRow | undefined;
}

export function getEnrichmentBySignalId(
  db: SqliteConnection,
  signalId: number,
): EnrichmentRow | undefined {
  const stmt = db.prepare(`
    SELECT
      e.id AS id,
      e.signal_id AS signalId,
      e.status AS status,
      e.sentiment AS sentiment,
      e.rationale AS rationale,
      e.earnings_flag AS earningsFlag,
      e.earnings_date AS earningsDate,
      e.sector AS sector,
      e.sector_trend AS sectorTrend,
      e.headlines AS headlines,
      e.confidence AS confidence
    FROM enrichments e
    WHERE e.signal_id = @signalId
  `);
  return stmt.get({ signalId }) as EnrichmentRow | undefined;
}

export function insertEnrichment(db: SqliteConnection, row: EnrichmentInsert): { lastInsertRowid: bigint } {
  const stmt = db.prepare(`
    INSERT INTO enrichments (
      signal_id, sentiment, rationale, earnings_flag, earnings_date,
      sector, sector_trend, headlines, confidence
    ) VALUES (
      @signalId, @sentiment, @rationale, @earningsFlag, @earningsDate,
      @sector, @sectorTrend, @headlines, @confidence
    )
  `);
  const info = stmt.run({
    signalId: row.signalId,
    sentiment: row.sentiment,
    rationale: row.rationale,
    earningsFlag: row.earningsFlag,
    earningsDate: row.earningsDate,
    sector: row.sector,
    sectorTrend: row.sectorTrend,
    headlines: row.headlines,
    confidence: row.confidence,
  });
  return { lastInsertRowid: BigInt(info.lastInsertRowid) };
}

export function insertEnrichmentStub(
  db: SqliteConnection,
  row: { signalId: number; status: EnrichmentStatus },
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO enrichments (
      signal_id, status, sentiment, rationale, confidence,
      earnings_flag, sector, sector_trend, headlines
    ) VALUES (
      @signalId, @status, 'UNKNOWN', '[enrichment unavailable]', 'UNKNOWN',
      0, 'N/A', 'N/A', '[]'
    )
  `);
  stmt.run({ signalId: row.signalId, status: row.status });
}

export function deleteEnrichmentForSignal(db: SqliteConnection, signalId: number): void {
  db.prepare(`DELETE FROM enrichments WHERE signal_id = @signalId`).run({ signalId });
}

export function markSignalAlerted(db: SqliteConnection, signalId: number): void {
  const stmt = db.prepare(`UPDATE signals SET alerted = 1 WHERE id = @id`);
  stmt.run({ id: signalId });
}

export function markWatchlistSignalsAlerted(db: SqliteConnection, signalIds: readonly number[]): void {
  if (signalIds.length === 0) {
    return;
  }
  const placeholders = signalIds.map(() => "?").join(", ");
  db.prepare(`UPDATE signals SET alerted = 1 WHERE id IN (${placeholders})`).run(...signalIds);
}

export function insertPosition(
  db: SqliteConnection,
  row: PositionInsert,
): { lastInsertRowid: bigint } {
  const tickerRow = db
    .prepare(`SELECT ticker FROM signals WHERE id = @signalId`)
    .get({ signalId: row.signalId }) as { ticker: string } | undefined;

  if (tickerRow?.ticker === "QQQ") {
    throw new Error(
      `insertPosition: refusing QQQ position — ` +
        `signalId=${String(row.signalId)} (QQQ is regime benchmark only)`,
    );
  }

  const stmt = db.prepare(`
    INSERT INTO positions (signal_id, entry_date, entry_price, status)
    VALUES (@signalId, @entryDate, @entryPrice, @status)
  `);
  const info = stmt.run({
    signalId: row.signalId,
    entryDate: row.entryDate,
    entryPrice: row.entryPrice,
    status: row.status,
  });
  return { lastInsertRowid: BigInt(info.lastInsertRowid) };
}

export type BacktestTradeExitReasonDb =
  | "TRAILING_STOP"
  | "INITIAL_STOP"
  | "TIME_EXIT"
  | "MANUAL"
  | "REBALANCE_DROP";

/** Live `positions.exit_reason` — same CHECK set as `backtest_trades` (migration 015). */
export type PositionExitReasonDb = BacktestTradeExitReasonDb;

export type LiveStrategyExitReason =
  | "TRAILING_STOP"
  | "MAX_HOLD"
  | "REBALANCE_DROP"
  | "FORCED_CLOSE";

export function mapLiveExitReason(reason: LiveStrategyExitReason): PositionExitReasonDb {
  switch (reason) {
    case "TRAILING_STOP":
      return "TRAILING_STOP";
    case "MAX_HOLD":
      return "TIME_EXIT";
    case "REBALANCE_DROP":
      return "REBALANCE_DROP";
    case "FORCED_CLOSE":
      return "MANUAL";
  }
}

export function closePosition(
  db: SqliteConnection,
  positionId: number,
  exitDate: string,
  exitPrice: number,
  exitReason: PositionExitReasonDb,
): void {
  if (
    typeof exitPrice !== "number" ||
    !Number.isFinite(exitPrice) ||
    exitPrice <= 0
  ) {
    throw new Error(
      `closePosition: refusing to persist corrupt exit — ` +
        `positionId=${String(positionId)} exitPrice=${String(exitPrice)} exitReason=${exitReason}`,
    );
  }
  const stmt = db.prepare(`
    UPDATE positions
    SET
      status = 'CLOSED',
      exit_date = @exitDate,
      exit_price = @exitPrice,
      exit_reason = @exitReason,
      pnl_pct = ROUND((@exitPrice - entry_price) / entry_price * 100, 4)
    WHERE id = @id AND status = 'OPEN'
  `);
  stmt.run({ id: positionId, exitDate, exitPrice, exitReason });
}

export interface BacktestRunInsert {
  runDate: string;
  fromDate: string;
  toDate: string;
  cagr: number;
  maxDrawdown: number;
  winRate: number;
  sharpeRatio: number;
  totalTrades: number;
  benchmarkCagr: number;
  /** Mean per-trade return, percentage points (e.g. 4.78 = +4.78% avg). */
  expectancy: number;
  strategy: string;
  windowLabel?: string | null;
  /** 1 = dashboard reference pin; default 0 (unlocked research). */
  locked?: number;
}

export function insertBacktestRun(db: SqliteConnection, row: BacktestRunInsert): { lastInsertRowid: bigint } {
  const stmt = db.prepare(`
    INSERT INTO backtest_runs (
      run_date, from_date, to_date, cagr, max_drawdown, win_rate, sharpe_ratio, total_trades, benchmark_cagr,
      expectancy, strategy, window_label, locked
    ) VALUES (
      @runDate, @fromDate, @toDate, @cagr, @maxDrawdown, @winRate, @sharpeRatio, @totalTrades, @benchmarkCagr,
      @expectancy, @strategy, @windowLabel, @locked
    )
  `);
  const info = stmt.run({
    runDate: row.runDate,
    fromDate: row.fromDate,
    toDate: row.toDate,
    cagr: row.cagr,
    maxDrawdown: row.maxDrawdown,
    winRate: row.winRate,
    sharpeRatio: row.sharpeRatio,
    totalTrades: row.totalTrades,
    benchmarkCagr: row.benchmarkCagr,
    expectancy: row.expectancy,
    strategy: row.strategy,
    windowLabel: row.windowLabel ?? null,
    locked: row.locked ?? 0,
  });
  return { lastInsertRowid: BigInt(info.lastInsertRowid) };
}

export interface BacktestTradeInsert {
  /** `backtest_runs.id` from the inserted run row. */
  runRowid: bigint;
  ticker: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  pnlPct: number | null;
  exitReason: BacktestTradeExitReasonDb;
}

export function insertBacktestTrade(db: SqliteConnection, row: BacktestTradeInsert): void {
  const stmt = db.prepare(`
    INSERT INTO backtest_trades (run_id, ticker, entry_date, entry_price, exit_date, exit_price, pnl_pct, exit_reason)
    VALUES (@runId, @ticker, @entryDate, @entryPrice, @exitDate, @exitPrice, @pnlPct, @exitReason)
  `);
  stmt.run({
    runId: Number(row.runRowid),
    ticker: row.ticker.toUpperCase(),
    entryDate: row.entryDate,
    entryPrice: row.entryPrice,
    exitDate: row.exitDate,
    exitPrice: row.exitPrice,
    pnlPct: row.pnlPct,
    exitReason: row.exitReason,
  });
}

/** Read a single `pipeline_state` value (e.g. scheduler `last_successful_run_date`). */
export function getPipelineState(db: SqliteConnection, key: string): string | null {
  const row = db.prepare(`SELECT value FROM pipeline_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Upsert a `pipeline_state` row; `updated_at` refreshed on conflict. */
export function setPipelineState(db: SqliteConnection, key: string, value: string): void {
  db.prepare(`
    INSERT INTO pipeline_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

export type StopRegime = "BASE" | "TIGHT";

export interface StopMovementInsert {
  position_id: number;
  as_of_date: string;
  previous_stop: number;
  new_stop: number;
  previous_high: number;
  new_high: number;
  stop_regime: StopRegime;
  close_price: number;
  atr14: number;
}

/** Append-only audit row for a trailing-stop ladder mutation (`011_position_audit`). */
export function insertStopMovement(db: SqliteConnection, fields: StopMovementInsert): void {
  db.prepare(`
    INSERT OR IGNORE INTO stop_movements (
      position_id, as_of_date, previous_stop, new_stop, previous_high, new_high,
      stop_regime, close_price, atr14
    ) VALUES (
      @position_id, @as_of_date, @previous_stop, @new_stop, @previous_high, @new_high,
      @stop_regime, @close_price, @atr14
    )
  `).run(fields);
}

/**
 * Closed positions that count toward the P7-F thesis-refresh gate
 * (excludes operator manual closes and rebalance rotation drops).
 */
export function getGenuineClosedTradeCount(db: SqliteConnection): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS c
      FROM positions
      WHERE status = 'CLOSED'
        AND exit_reason NOT IN ('MANUAL', 'REBALANCE_DROP')
    `)
    .get() as { c: number };
  return row.c;
}
