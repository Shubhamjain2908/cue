import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { z } from "zod";

import { getConfig } from "../config/index.js";
import { insertBacktestRun } from "../db/queries.js";
import { initSchema } from "../db/schema.js";
import { generateSignal } from "../strategy/signals.js";
import type { OpenPositionContext, SignalThresholds } from "../strategy/types.js";
import { computeBacktestMetrics, cagrPct } from "./metrics.js";
import type { ClosedBacktestTrade, EquityPoint } from "./types.js";
import {
  BACKTEST_MAX_CONCURRENT_POSITIONS,
  BACKTEST_MAX_HOLD_DAYS,
  BACKTEST_POSITION_USD,
  BACKTEST_SLIPPAGE_BUY_MULTIPLIER,
  BACKTEST_SLIPPAGE_SELL_MULTIPLIER,
  BACKTEST_STOP_LOSS_FRACTION,
} from "./types.js";

type SqliteConnection = InstanceType<typeof Database>;

const universeSchema = z.object({
  tickers: z.array(z.string().min(1)),
});

/** Nasdaq-100 proxy for Phase 1 (SPY not required in DB). */
export const BACKTEST_BENCHMARK_TICKER = "QQQ";

const INITIAL_CASH_USD = 2500;

/** Calendar days to pull before `fromDate` for RSI / volume windows. */
const WARMUP_CALENDAR_DAYS = 200;

/** Calendar days after `toDate` to keep simulating T+1 fills for signals on `toDate`. */
const SETTLEMENT_EXTENSION_CALENDAR_DAYS = 45;

interface DailyBar {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SimPosition {
  entryDate: string;
  entryFillPrice: number;
  shares: number;
  stopLevel: number;
}

function compareIsoDate(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function parseIsoUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function addCalendarDays(iso: string, days: number): string {
  const ms = parseIsoUtcMs(iso) + days * 86_400_000;
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Count the number of dates in `tradingDates` that fall in the range
 * (entryDate, asOf] — i.e. strictly after entry, up to and including asOf.
 * Uses the sorted `sortedDates` array already built in runBacktest.
 */
function tradingDaysHeld(
  sortedDates: readonly string[],
  entryDate: string,
  asOf: string,
): number {
  let count = 0;
  for (const d of sortedDates) {
    if (d <= entryDate) {
      continue;
    }
    if (d > asOf) {
      break;
    }
    count++;
  }
  return count;
}

function calendarYearFraction(fromIso: string, toIso: string): number {
  const raw = (parseIsoUtcMs(toIso) - parseIsoUtcMs(fromIso)) / 86_400_000 / 365.25;
  return Math.max(raw, 1e-9);
}

function upperBoundInclusiveByDate(bars: readonly DailyBar[], asOf: string): number {
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

/** Smallest index with `bars[i].date >= from` (bars sorted by date ascending). */
function lowerBoundInclusiveByDate(bars: readonly DailyBar[], from: string): number {
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

function sliceClosesVolumes(
  bars: readonly DailyBar[],
  asOf: string,
): { close: readonly number[]; volume: readonly number[] } | null {
  const ub = upperBoundInclusiveByDate(bars, asOf);
  if (ub < 0) {
    return null;
  }
  const slice = bars.slice(0, ub + 1);
  return {
    close: slice.map((b) => b.close),
    volume: slice.map((b) => b.volume),
  };
}

function closeMarkAsOf(bars: readonly DailyBar[], asOf: string): number | null {
  const ub = upperBoundInclusiveByDate(bars, asOf);
  if (ub < 0) {
    return null;
  }
  return bars[ub]!.close;
}

function thresholdsFromConfig(): SignalThresholds {
  const c = getConfig();
  return {
    smaPeriod: c.smaPeriod,
    buyRsiMin: c.buyRsiMin,
    buyRsiMax: c.buyRsiMax,
    exitRsiThreshold: c.exitRsiThreshold,
    stopLossPct: c.stopLossPct,
    maxHoldDays: c.maxHoldDays,
  };
}

function loadUniverseTickers(): string[] {
  const { UNIVERSE } = getConfig();
  const filePath = path.join(process.cwd(), "data", "universe", `${UNIVERSE}.json`);
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = universeSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid universe file ${filePath}: ${parsed.error.message}`);
  }
  return parsed.data.tickers.map((t) => t.toUpperCase());
}

function hydrateDailyPrices(
  db: SqliteConnection,
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

function indexByTickerAndDate(rows: readonly DailyBar[]): {
  byTicker: Map<string, DailyBar[]>;
  byDate: Map<string, Map<string, DailyBar>>;
} {
  const byTicker = new Map<string, DailyBar[]>();
  const byDate = new Map<string, Map<string, DailyBar>>();
  for (const row of rows) {
    const t = row.ticker.toUpperCase();
    const d = row.date;
    let arr = byTicker.get(t);
    if (!arr) {
      arr = [];
      byTicker.set(t, arr);
    }
    arr.push({ ...row, ticker: t, date: d });

    let dayMap = byDate.get(d);
    if (!dayMap) {
      dayMap = new Map();
      byDate.set(d, dayMap);
    }
    dayMap.set(t, { ...row, ticker: t, date: d });
  }
  return { byTicker, byDate };
}

function benchmarkBuyHoldCagrPct(
  qqqBars: readonly DailyBar[],
  fromDate: string,
  toDate: string,
): number | null {
  if (qqqBars.length === 0) {
    return null;
  }
  // First bar on or after `fromDate`. Using upperBound(fromDate) fails when the
  // benchmark’s first print is after the window start (e.g. QQQ from 2021-05-17 vs --from 2021-01-01).
  const lbFrom = lowerBoundInclusiveByDate(qqqBars, fromDate);
  const ubTo = upperBoundInclusiveByDate(qqqBars, toDate);
  if (lbFrom < 0 || ubTo < 0 || lbFrom > ubTo) {
    return null;
  }
  const start = qqqBars[lbFrom]!.close;
  const end = qqqBars[ubTo]!.close;
  const spanFrom = qqqBars[lbFrom]!.date;
  const spanTo = qqqBars[ubTo]!.date;
  const yf = calendarYearFraction(spanFrom, spanTo);
  return cagrPct(start, end, yf);
}

function fmtPct(x: number | null, digits = 2): string {
  if (x === null || Number.isNaN(x)) {
    return "n/a";
  }
  return `${x.toFixed(digits)}%`;
}

function fmtNum(x: number | null, digits = 3): string {
  if (x === null || Number.isNaN(x)) {
    return "n/a";
  }
  return x.toFixed(digits);
}

function printSummary(
  fromDate: string,
  toDate: string,
  metrics: ReturnType<typeof computeBacktestMetrics>,
  benchmarkCagrPct: number | null,
): void {
  const rows: [string, string][] = [
    ["Window", `${fromDate} → ${toDate}`],
    ["CAGR (strategy)", fmtPct(metrics.cagrPct)],
    ["Max drawdown", fmtPct(metrics.maxDrawdownPct)],
    ["Win rate", fmtPct(metrics.winRatePct)],
    ["Sharpe (ann.)", fmtNum(metrics.sharpeRatio)],
    ["Total trades", String(metrics.totalTrades)],
    [`Benchmark (${BACKTEST_BENCHMARK_TICKER}) CAGR`, fmtPct(benchmarkCagrPct)],
  ];
  const labelW = Math.max(...rows.map(([a]) => a.length));
  console.log("");
  console.log("Cue backtest");
  console.log("-".repeat(Math.max(40, labelW + 28)));
  for (const [label, value] of rows) {
    console.log(`${label.padEnd(labelW)}  ${value}`);
  }
  console.log("-".repeat(Math.max(40, labelW + 28)));
  console.log("");
}

export interface RunBacktestResult {
  equityPoints: EquityPoint[];
  closedTrades: ClosedBacktestTrade[];
  metrics: ReturnType<typeof computeBacktestMetrics>;
  benchmarkCagrPct: number | null;
  yearFraction: number;
}

/**
 * Replay the strategy day-by-day (Cue spec §7.2): EOD signals on date T, fills on T+1 open,
 * MTM equity at each T close. Uses $2,500 starting cash and $400 per slot (see `types.ts`).
 */
export function runBacktest(
  db: SqliteConnection,
  fromDate: string,
  toDate: string,
): RunBacktestResult {
  if (compareIsoDate(fromDate, toDate) > 0) {
    throw new Error(`runBacktest: fromDate ${fromDate} is after toDate ${toDate}`);
  }

  const thresholds = thresholdsFromConfig();
  const universe = loadUniverseTickers();
  const allTickers = [...new Set([...universe, BACKTEST_BENCHMARK_TICKER])].sort((a, b) =>
    a.localeCompare(b),
  );

  const dataFrom = addCalendarDays(fromDate, -WARMUP_CALENDAR_DAYS);
  const dataTo = addCalendarDays(toDate, SETTLEMENT_EXTENSION_CALENDAR_DAYS);
  const rows = hydrateDailyPrices(db, allTickers, dataFrom, dataTo);
  if (rows.length === 0) {
    const span = db
      .prepare(`SELECT MIN(date) AS lo, MAX(date) AS hi FROM daily_prices`)
      .get() as { lo: string | null; hi: string | null };
    console.warn(
      [
        "Backtest: hydrated 0 OHLCV rows (nothing to simulate).",
        `Requested hydrate window: ${dataFrom} → ${dataTo} (warmup + settlement padding).`,
        span.lo && span.hi
          ? `Table daily_prices overall: ${span.lo} → ${span.hi}.`
          : "Table daily_prices is empty.",
        "Align --from/--to with loaded data, or run fetch for that range.",
      ].join("\n"),
    );
  }
  const { byTicker, byDate } = indexByTickerAndDate(rows);
  const sortedDates = [...byDate.keys()].sort(compareIsoDate);

  const qqqBars = byTicker.get(BACKTEST_BENCHMARK_TICKER) ?? [];
  if (rows.length > 0 && qqqBars.length === 0) {
    console.warn(
      `Backtest: no ${BACKTEST_BENCHMARK_TICKER} bars in the hydrated window; benchmark CAGR will be n/a (fetch ${BACKTEST_BENCHMARK_TICKER} for a baseline).`,
    );
  }
  const yearFraction = calendarYearFraction(fromDate, toDate);
  const benchmarkCagrPct = benchmarkBuyHoldCagrPct(qqqBars, fromDate, toDate);

  let cash = INITIAL_CASH_USD;
  const positions = new Map<string, SimPosition>();
  const pendingBuys = new Set<string>();
  const pendingStandardExits = new Set<string>();

  const equityPoints: EquityPoint[] = [];
  const closedTrades: ClosedBacktestTrade[] = [];

  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i]!;

    if (i > 0) {
      const dayMap = byDate.get(date);
      if (dayMap) {
        const tickersToExit: string[] = [];
        for (const [ticker] of positions) {
          tickersToExit.push(ticker);
        }
        tickersToExit.sort((a, b) => a.localeCompare(b));

        for (const ticker of tickersToExit) {
          const pos = positions.get(ticker);
          if (!pos) {
            continue;
          }
          const bar = dayMap.get(ticker);
          if (!bar) {
            continue;
          }
          const openPx = bar.open;
          const gapOrStop = openPx <= pos.stopLevel;
          const standard = pendingStandardExits.has(ticker);
          const daysHeld = tradingDaysHeld(sortedDates, pos.entryDate, date);
          const maxHoldBreached = daysHeld >= BACKTEST_MAX_HOLD_DAYS;
          if (gapOrStop || standard || maxHoldBreached) {
            const exitFill = openPx * BACKTEST_SLIPPAGE_SELL_MULTIPLIER;
            const proceeds = pos.shares * exitFill;
            cash += proceeds;
            const costBasis = pos.shares * pos.entryFillPrice;
            closedTrades.push({
              ticker,
              entryDate: pos.entryDate,
              exitDate: date,
              realizedPnlUsd: proceeds - costBasis,
            });
            positions.delete(ticker);
            pendingStandardExits.delete(ticker);
          }
        }

        const pendingSorted = [...pendingBuys].sort((a, b) => a.localeCompare(b));
        for (const ticker of pendingSorted) {
          if (positions.size >= BACKTEST_MAX_CONCURRENT_POSITIONS) {
            break;
          }
          if (positions.has(ticker)) {
            pendingBuys.delete(ticker);
            continue;
          }
          const bar = dayMap.get(ticker);
          if (!bar) {
            continue;
          }
          const buyFill = bar.open * BACKTEST_SLIPPAGE_BUY_MULTIPLIER;
          const allocation = BACKTEST_POSITION_USD;
          if (cash < allocation) {
            continue;
          }
          const shares = allocation / buyFill;
          const cost = shares * buyFill;
          if (cost > cash + 1e-6) {
            continue;
          }
          cash -= cost;
          positions.set(ticker, {
            entryDate: date,
            entryFillPrice: buyFill,
            shares,
            stopLevel: buyFill * (1 - BACKTEST_STOP_LOSS_FRACTION),
          });
          pendingBuys.delete(ticker);
        }
      }
    }

    const inSignalWindow = compareIsoDate(date, fromDate) >= 0 && compareIsoDate(date, toDate) <= 0;
    if (inSignalWindow) {
      const nextBuys = new Set<string>();
      const nextStandardExits = new Set<string>();

      const slotsAvailable = BACKTEST_MAX_CONCURRENT_POSITIONS - positions.size;
      let slotsLeft = slotsAvailable;
      const sortedUniverse = [...universe].sort((a, b) => a.localeCompare(b));

      for (const ticker of sortedUniverse) {
        const series = byTicker.get(ticker);
        if (!series) {
          continue;
        }
        const sliced = sliceClosesVolumes(series, date);
        if (!sliced) {
          continue;
        }

        const openPos = positions.get(ticker);
        const positionCtx: OpenPositionContext | undefined =
          openPos === undefined
            ? undefined
            : { entryPrice: openPos.entryFillPrice };

        const { signal } = generateSignal({
          close: sliced.close,
          volume: sliced.volume,
          thresholds,
          position: positionCtx,
        });

        if (openPos === undefined) {
          if (signal === "BUY" && slotsLeft > 0) {
            nextBuys.add(ticker);
            slotsLeft -= 1;
          }
        } else if (signal === "SELL") {
          nextStandardExits.add(ticker);
        }
      }

      pendingBuys.clear();
      pendingStandardExits.clear();
      for (const t of nextBuys) {
        pendingBuys.add(t);
      }
      for (const t of nextStandardExits) {
        pendingStandardExits.add(t);
      }
    }

    if (inSignalWindow) {
      let mtm = cash;
      for (const [ticker, pos] of positions) {
        const series = byTicker.get(ticker);
        if (!series) {
          continue;
        }
        const px = closeMarkAsOf(series, date);
        if (px === null) {
          continue;
        }
        mtm += pos.shares * px;
      }
      equityPoints.push({ date, equityUsd: mtm });
    }
  }

  const metrics = computeBacktestMetrics({
    equityPoints,
    closedTrades,
    yearFraction,
  });

  return { equityPoints, closedTrades, metrics, benchmarkCagrPct, yearFraction };
}

function parseCliDates(): { from: string; to: string } {
  let from = "2021-01-01";
  let to = "2023-12-31";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from" && argv[i + 1]) {
      from = argv[++i]!;
    } else if (a === "--to" && argv[i + 1]) {
      to = argv[++i]!;
    }
  }
  return { from, to };
}

function realOrZero(x: number | null): number {
  return x === null || Number.isNaN(x) ? 0 : x;
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");

if (isMain) {
  const { from, to } = parseCliDates();
  const config = getConfig();
  const db = new Database(config.DB_PATH);
  try {
    initSchema(db);
    const result = runBacktest(db, from, to);
    printSummary(from, to, result.metrics, result.benchmarkCagrPct);

    if (result.metrics.totalTrades === 0 && result.equityPoints.length > 0) {
      console.warn(
        "Backtest: 0 round-trip trades — no BUY signals passed the trend + pullback gates on this window and universe (strategy stayed in cash).",
      );
    }

    const runDate = new Date().toISOString().slice(0, 10);
    const dbAbsPath = path.resolve(process.cwd(), config.DB_PATH);
    const { lastInsertRowid } = insertBacktestRun(db, {
      runDate,
      fromDate: from,
      toDate: to,
      cagr: realOrZero(result.metrics.cagrPct),
      maxDrawdown: realOrZero(result.metrics.maxDrawdownPct),
      winRate: realOrZero(result.metrics.winRatePct),
      sharpeRatio: realOrZero(result.metrics.sharpeRatio),
      totalTrades: result.metrics.totalTrades,
      benchmarkCagr: realOrZero(result.benchmarkCagrPct),
    });
    console.log(
      `Saved backtest run to SQLite (id=${lastInsertRowid.toString()}, file=${dbAbsPath}). Point sqlite-cue / other tools at this path.`,
    );
  } finally {
    db.close();
  }
}
