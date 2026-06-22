/**
 * Shared market-data utilities extracted from duplicated definitions across the codebase.
 *
 * These pure functions operate on `DailyBar[]` arrays sorted ascending by date
 * and are used by the backtest runner, live screener, and research strategies.
 */

import type Database from "better-sqlite3";

/** One daily OHLCV row from `daily_prices`. */
export interface DailyBar {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type DbConnection = InstanceType<typeof Database>;

/**
 * Binary-search upper bound: largest index where `bars[i].date <= asOf`.
 * Returns -1 when no bar satisfies the constraint.
 */
export function upperBoundInclusiveByDate(
  bars: readonly DailyBar[],
  asOf: string,
): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = bars[mid]!.date;
    if (d <= asOf) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Binary-search lower bound: smallest index where `bars[i].date >= from`.
 * Returns -1 when no bar satisfies the constraint.
 */
export function lowerBoundInclusiveByDate(
  bars: readonly DailyBar[],
  from: string,
): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date >= from) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/** Bars up to and including `asOf` (null when no bar matches). */
export function sliceBarsThrough(
  bars: readonly DailyBar[],
  asOf: string,
): DailyBar[] | null {
  const ub = upperBoundInclusiveByDate(bars, asOf);
  if (ub < 0) return null;
  return bars.slice(0, ub + 1);
}

/** Close price of the bar on or before `asOf` (null when no match). */
export function closeMarkAsOf(
  bars: readonly DailyBar[],
  asOf: string,
): number | null {
  const ub = upperBoundInclusiveByDate(bars, asOf);
  if (ub < 0) return null;
  return bars[ub]!.close;
}

/** Index bars by ticker (uppercased). */
export function indexByTicker(
  rows: readonly DailyBar[],
): Map<string, DailyBar[]> {
  const byTicker = new Map<string, DailyBar[]>();
  for (const row of rows) {
    const t = row.ticker.toUpperCase();
    let arr = byTicker.get(t);
    if (!arr) {
      arr = [];
      byTicker.set(t, arr);
    }
    arr.push({ ...row, ticker: t, date: row.date });
  }
  return byTicker;
}

/** Index bars by date, then ticker. */
export function indexByDate(
  rows: readonly DailyBar[],
): Map<string, Map<string, DailyBar>> {
  const byDate = new Map<string, Map<string, DailyBar>>();
  for (const row of rows) {
    const t = row.ticker.toUpperCase();
    const d = row.date;
    let dayMap = byDate.get(d);
    if (!dayMap) {
      dayMap = new Map();
      byDate.set(d, dayMap);
    }
    dayMap.set(t, { ...row, ticker: t, date: d });
  }
  return byDate;
}

/** Fetch QQQ trading dates in [dateFrom, dateTo] ascending. */
export function loadQqqTradingDates(
  db: DbConnection,
  dateFrom: string,
  dateTo: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT date FROM daily_prices WHERE ticker = 'QQQ' AND date >= ? AND date <= ? ORDER BY date ASC`,
    )
    .all(dateFrom, dateTo) as { date: string }[];
  return rows.map((r) => r.date);
}

/**
 * Hydrate daily OHLCV rows from `daily_prices` for the given tickers and date range.
 */
export function hydrateDailyPrices(
  db: DbConnection,
  tickers: readonly string[],
  dateFrom: string,
  dateTo: string,
): DailyBar[] {
  if (tickers.length === 0) {
    return [];
  }
  const placeholders = tickers.map(() => "?").join(", ");
  const stmt = db.prepare(`
    SELECT ticker, date, open, high, low, close, volume
    FROM daily_prices
    WHERE ticker IN (${placeholders})
      AND date >= ?
      AND date <= ?
    ORDER BY date ASC, ticker ASC
  `);
  return stmt.all(...tickers, dateFrom, dateTo) as DailyBar[];
}
