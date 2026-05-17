import Database from "better-sqlite3";

type SqliteConnection = InstanceType<typeof Database>;

export type SignalSide = "BUY" | "SELL" | "HOLD";

export type PositionStatus = "OPEN" | "CLOSED";

export interface SignalInsert {
  ticker: string;
  date: string;
  signal: SignalSide;
  price: number;
  rsi14: number;
  momentum5d: number;
  volumeRatio: number;
  stopLoss: number;
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

export function insertSignal(
  db: SqliteConnection,
  row: SignalInsert,
): { changes: number; lastInsertRowid: bigint } {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO signals (
      ticker, date, signal, price, rsi14, momentum_5d, volume_ratio, stop_loss, alerted
    ) VALUES (
      @ticker, @date, @signal, @price, @rsi14, @momentum5d, @volumeRatio, @stopLoss, 0
    )
  `);
  const info = stmt.run({
    ticker: row.ticker,
    date: row.date,
    signal: row.signal,
    price: row.price,
    rsi14: row.rsi14,
    momentum5d: row.momentum5d,
    volumeRatio: row.volumeRatio,
    stopLoss: row.stopLoss,
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
