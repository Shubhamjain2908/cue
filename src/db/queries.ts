import Database from "better-sqlite3";

type SqliteConnection = InstanceType<typeof Database>;

export type SignalSide = "BUY" | "SELL" | "HOLD";

export type PositionStatus = "OPEN" | "CLOSED";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export interface SignalInsert {
  ticker: string;
  date: string;
  signal: SignalSide;
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
  initialAtrStop: number;
}

/** BUY + enrichment for Telegram (one row per signal). */
export interface BuyAlertPendingRow extends BuySignalForEnrichmentRow {
  sentiment: string;
  rationale: string;
  earningsDate: string | null;
  sector: string | null;
  confidence: ConfidenceLevel;
}

export interface EnrichmentRow {
  id: number;
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

export function insertSignal(
  db: SqliteConnection,
  row: SignalInsert,
): { changes: number; lastInsertRowid: bigint } {
  requireBuyMomentum(row);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO signals (
      ticker, date, signal, price, alerted,
      momentum_rank, universe_ranked_count, momentum_12_1_return, atr14, initial_atr_stop
    ) VALUES (
      @ticker, @date, @signal, @price, 0,
      @momentumRank, @universeRankedCount, @momentum12_1Return, @atr14, @initialAtrStop
    )
  `);
  const info = stmt.run({
    ticker: row.ticker,
    date: row.date,
    signal: row.signal,
    price: row.price,
    momentumRank: row.momentumRank ?? null,
    universeRankedCount: row.universeRankedCount ?? null,
    momentum12_1Return: row.momentum12_1Return ?? null,
    atr14: row.atr14 ?? null,
    initialAtrStop: row.initialAtrStop ?? null,
  });
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
      e.confidence AS confidence
    FROM signals s
    INNER JOIN enrichments e ON e.signal_id = s.id
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
    WHERE s.id = @id AND s.signal = 'BUY'
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

export function markSignalAlerted(db: SqliteConnection, signalId: number): void {
  const stmt = db.prepare(`UPDATE signals SET alerted = 1 WHERE id = @id`);
  stmt.run({ id: signalId });
}

export function insertPosition(
  db: SqliteConnection,
  row: PositionInsert,
): { lastInsertRowid: bigint } {
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

export function closePosition(
  db: SqliteConnection,
  positionId: number,
  exitDate: string,
  exitPrice: number,
): void {
  const stmt = db.prepare(`
    UPDATE positions
    SET status = 'CLOSED', exit_date = @exitDate, exit_price = @exitPrice
    WHERE id = @id AND status = 'OPEN'
  `);
  stmt.run({ id: positionId, exitDate, exitPrice });
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
}

export function insertBacktestRun(db: SqliteConnection, row: BacktestRunInsert): { lastInsertRowid: bigint } {
  const stmt = db.prepare(`
    INSERT INTO backtest_runs (
      run_date, from_date, to_date, cagr, max_drawdown, win_rate, sharpe_ratio, total_trades, benchmark_cagr,
      expectancy
    ) VALUES (
      @runDate, @fromDate, @toDate, @cagr, @maxDrawdown, @winRate, @sharpeRatio, @totalTrades, @benchmarkCagr,
      @expectancy
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
  });
  return { lastInsertRowid: BigInt(info.lastInsertRowid) };
}
