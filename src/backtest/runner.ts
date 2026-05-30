import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import type { BacktestTradeExitReasonDb } from "../db/queries.js";
import { insertBacktestRun, insertBacktestTrade } from "../db/queries.js";
import { initSchema } from "../db/schema.js";
import { computeTrailingStop, rankUniverse } from "../analysers/ranker.js";
import { atr, sma } from "../enrichers/indicators.js";
import { DEFAULT_RANKING_CONFIG, type RankingConfig } from "../enrichers/momentum-types.js";
import { computeBacktestMetrics, cagrPct } from "./metrics.js";
import type {
  ClosedBacktestTrade,
  EquityPoint,
  MomentumBacktestOptions,
  RunBacktestResult,
  VixRegimeGate,
} from "./types.js";
import {
  BACKTEST_MAX_CONCURRENT_POSITIONS,
  BACKTEST_SLIPPAGE_BUY_MULTIPLIER,
  BACKTEST_SLIPPAGE_SELL_MULTIPLIER,
  BACKTEST_POSITION_USD,
} from "./types.js";
import { loadUniverseTickers } from "../universe/load-universe.js";
import {
  printQualityGarpSummary,
  runQualityGarpBacktest,
} from "./strategies/quality-garp.js";

type SqliteConnection = InstanceType<typeof Database>;

/** Nasdaq-100 proxy for Phase 1 (SPY not required in DB). */
export const BACKTEST_BENCHMARK_TICKER = "QQQ";

const INITIAL_CASH_USD = 2500;

/** Calendar days to pull before `fromDate` for momentum / SMA / ATR windows. */
const WARMUP_CALENDAR_DAYS = 550;

/** Calendar days after `toDate` to simulate pending fills through settlement extension. */
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
  entryAtr: number;
  currentStop: number;
  highestCloseSinceEntry: number;
}

type StrategyExitReason =
  | "TRAILING_STOP"
  | "MAX_HOLD"
  | "REBALANCE_DROP"
  | "FORCED_CLOSE";

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

/** 1 = Monday … 5 = Friday (ISO weekday, matches `Date#getUTCDay()` for Mon–Fri). */
function isoWeekdayMon1ToFri5(iso: string): number {
  const dow = new Date(parseIsoUtcMs(iso)).getUTCDay();
  if (dow === 0 || dow === 6) {
    return 0;
  }
  return dow;
}

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

function sliceBarsThrough(bars: readonly DailyBar[], asOf: string): DailyBar[] | null {
  const ub = upperBoundInclusiveByDate(bars, asOf);
  if (ub < 0) {
    return null;
  }
  return bars.slice(0, ub + 1);
}

function closeMarkAsOf(bars: readonly DailyBar[], asOf: string): number | null {
  const ub = upperBoundInclusiveByDate(bars, asOf);
  if (ub < 0) {
    return null;
  }
  return bars[ub]!.close;
}

function loadQqqTradingDates(
  db: SqliteConnection,
  dateFrom: string,
  dateTo: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT date FROM daily_prices WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
    )
    .all(BACKTEST_BENCHMARK_TICKER, dateFrom, dateTo) as { date: string }[];
  return rows.map((r) => r.date);
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

function indexByTicker(rows: readonly DailyBar[]): Map<string, DailyBar[]> {
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

function indexByDate(rows: readonly DailyBar[]): Map<string, Map<string, DailyBar>> {
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

function benchmarkBuyHoldCagrPct(
  qqqBars: readonly DailyBar[],
  fromDate: string,
  toDate: string,
): number | null {
  if (qqqBars.length === 0) {
    return null;
  }
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

function toBacktestExitReason(r: StrategyExitReason): ClosedBacktestTrade["exitReason"] {
  switch (r) {
    case "TRAILING_STOP":
      return "gapOrStop";
    case "MAX_HOLD":
      return "maxHoldDays";
    case "REBALANCE_DROP":
      return "standardTrendBreak";
    case "FORCED_CLOSE":
      return "standardTakeProfit";
  }
}

function strategyBucketFromClosedTrade(t: ClosedBacktestTrade): StrategyExitReason {
  switch (t.exitReason) {
    case "gapOrStop":
      return "TRAILING_STOP";
    case "maxHoldDays":
      return "MAX_HOLD";
    case "standardTrendBreak":
      return "REBALANCE_DROP";
    case "standardTakeProfit":
      return "FORCED_CLOSE";
  }
}

/** Calendar days between exit and entry (UTC midnight ISO dates). */
function calendarHoldDaysHeld(entryDate: string, exitDate: string): number {
  return (parseIsoUtcMs(exitDate) - parseIsoUtcMs(entryDate)) / (1000 * 60 * 60 * 24);
}

interface ExitBucketAgg {
  count: number;
  sumPnlPct: number;
  sumHoldDays: number;
}

function emptyExitBucketAgg(): Record<StrategyExitReason, ExitBucketAgg> {
  return {
    TRAILING_STOP: { count: 0, sumPnlPct: 0, sumHoldDays: 0 },
    MAX_HOLD: { count: 0, sumPnlPct: 0, sumHoldDays: 0 },
    REBALANCE_DROP: { count: 0, sumPnlPct: 0, sumHoldDays: 0 },
    FORCED_CLOSE: { count: 0, sumPnlPct: 0, sumHoldDays: 0 },
  };
}

function aggregateExitBuckets(closedTrades: readonly ClosedBacktestTrade[]): Record<
  StrategyExitReason,
  ExitBucketAgg
> {
  const out = emptyExitBucketAgg();
  for (const t of closedTrades) {
    const bucket = strategyBucketFromClosedTrade(t);
    const pnlPct =
      t.entryFillPrice !== 0
        ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
        : 0;
    const holdDays = calendarHoldDaysHeld(t.entryDate, t.exitDate);
    const cell = out[bucket];
    cell.count += 1;
    cell.sumPnlPct += pnlPct;
    cell.sumHoldDays += holdDays;
  }
  return out;
}

function mean(nums: readonly number[]): number | null {
  if (nums.length === 0) {
    return null;
  }
  let s = 0;
  for (const n of nums) {
    s += n;
  }
  return s / nums.length;
}

function printSummary(
  fromDate: string,
  toDate: string,
  metrics: ReturnType<typeof computeBacktestMetrics>,
  benchmarkCagrPct: number | null,
  expectancyPctPerTrade: number | null,
  exitAgg: Record<StrategyExitReason, ExitBucketAgg>,
): void {
  const rows: [string, string][] = [
    ["Window", `${fromDate} → ${toDate}`],
    ["CAGR (strategy)", fmtPct(metrics.cagrPct)],
    ["Max drawdown", fmtPct(metrics.maxDrawdownPct)],
    ["Win rate", fmtPct(metrics.winRatePct)],
    ["Sharpe (ann.)", fmtNum(metrics.sharpeRatio)],
    ["Expectancy (avg P&L % / trade)", fmtPct(expectancyPctPerTrade, 3)],
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
  console.log("Exit bucket breakdown (strategy labels):");
  for (const k of [
    "TRAILING_STOP",
    "MAX_HOLD",
    "REBALANCE_DROP",
    "FORCED_CLOSE",
  ] as const) {
    const { count, sumPnlPct, sumHoldDays } = exitAgg[k];
    const avgPnl = count > 0 ? sumPnlPct / count : 0;
    const avgHold = count > 0 ? sumHoldDays / count : 0;
    const label = k;
    console.log(
      `  ${label.padEnd(18)} ${count.toString().padEnd(4)} | Avg P&L: ${avgPnl.toFixed(2)}% | Avg Hold: ${avgHold.toFixed(1)} days`,
    );
  }
  console.log("");
}

function rankingConfigFromDefaults(): RankingConfig {
  return { ...DEFAULT_RANKING_CONFIG };
}

/**
 * P7-G stacked gate: allow new BUYs when VIX close <= ceiling.
 * Missing ^VIX session → gate OPEN (warn, do not throw).
 */
export function allowNewBuysForVixSession(sessionDate: string, vixGate?: VixRegimeGate): boolean {
  if (vixGate === undefined) {
    return true;
  }
  const vixClose = vixGate.vixByDate.get(sessionDate);
  if (vixClose === undefined) {
    console.warn(
      `runBacktest: no ^VIX close for session ${sessionDate}; VIX gate OPEN (allow BUYs)`,
    );
    return true;
  }
  return vixClose <= vixGate.maxVix;
}

/**
 * Weekly rebalance cross-sectional momentum (§6.2) with ATR trailing stops (§6.3).
 */
export function runBacktest(
  db: SqliteConnection,
  fromDate: string,
  toDate: string,
  options?: MomentumBacktestOptions,
): RunBacktestResult {
  if (compareIsoDate(fromDate, toDate) > 0) {
    throw new Error(`runBacktest: fromDate ${fromDate} is after toDate ${toDate}`);
  }

  const cfg = rankingConfigFromDefaults();
  const appCfg = getConfig();
  const positionUsd = appCfg.POSITION_SIZE_USD ?? BACKTEST_POSITION_USD;

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

  const byTicker = indexByTicker(rows);
  const byDate = indexByDate(rows);
  const sortedTradingDates = loadQqqTradingDates(db, dataFrom, dataTo);

  const qqqSeries = byTicker.get(BACKTEST_BENCHMARK_TICKER);
  if (!qqqSeries) {
    throw new Error("QQQ not found in daily_prices — required for calendar and regime filter");
  }
  const qqqBars = qqqSeries;
  const yearFraction = calendarYearFraction(fromDate, toDate);
  const benchmarkCagrPct = benchmarkBuyHoldCagrPct(qqqBars, fromDate, toDate);

  let cash = INITIAL_CASH_USD;
  const positions = new Map<string, SimPosition>();
  const pendingExitReason = new Map<string, StrategyExitReason>();
  const pendingBuys = new Map<string, { entryAtr: number }>();

  const equityPoints: EquityPoint[] = [];
  const closedTrades: ClosedBacktestTrade[] = [];

  const exitBuckets: Record<StrategyExitReason, number> = {
    TRAILING_STOP: 0,
    MAX_HOLD: 0,
    REBALANCE_DROP: 0,
    FORCED_CLOSE: 0,
  };

  const datesLeqTo = sortedTradingDates.filter((d) => compareIsoDate(d, toDate) <= 0);
  const finalBacktestDate =
    datesLeqTo.length > 0 ? datesLeqTo[datesLeqTo.length - 1]! : null;

  const closePosition = (
    ticker: string,
    pos: SimPosition,
    exitDate: string,
    exitFillPrice: number,
    reason: StrategyExitReason,
  ): void => {
    const proceeds = pos.shares * exitFillPrice;
    cash += proceeds;
    const costBasis = pos.shares * pos.entryFillPrice;
    closedTrades.push({
      ticker,
      entryDate: pos.entryDate,
      exitDate,
      realizedPnlUsd: proceeds - costBasis,
      exitReason: toBacktestExitReason(reason),
      entryFillPrice: pos.entryFillPrice,
      exitFillPrice,
    });
    exitBuckets[reason] += 1;
    positions.delete(ticker);
    pendingExitReason.delete(ticker);
  };

  for (let di = 0; di < sortedTradingDates.length; di++) {
    const date = sortedTradingDates[di]!;
    const dayMap = byDate.get(date);
    if (!dayMap) {
      continue;
    }

    if (di > 0) {
      const tickersToTouch = new Set<string>([...positions.keys(), ...pendingExitReason.keys()]);
      for (const t of pendingBuys.keys()) {
        tickersToTouch.add(t);
      }
      const sortedTouch = [...tickersToTouch].sort((a, b) => a.localeCompare(b));

      for (const ticker of sortedTouch) {
        const exitReason = pendingExitReason.get(ticker);
        const pos = positions.get(ticker);
        if (exitReason !== undefined && pos !== undefined) {
          const bar = dayMap.get(ticker);
          if (!bar) {
            continue;
          }
          const exitFill = bar.open * BACKTEST_SLIPPAGE_SELL_MULTIPLIER;
          closePosition(ticker, pos, date, exitFill, exitReason);
        }
      }

      const buyOrder = [...pendingBuys.keys()].sort((a, b) => a.localeCompare(b));
      for (const ticker of buyOrder) {
        if (positions.size >= BACKTEST_MAX_CONCURRENT_POSITIONS) {
          break;
        }
        if (positions.has(ticker)) {
          pendingBuys.delete(ticker);
          continue;
        }
        const meta = pendingBuys.get(ticker);
        if (!meta) {
          continue;
        }
        const bar = dayMap.get(ticker);
        if (!bar) {
          continue;
        }
        const buyFill = bar.open * BACKTEST_SLIPPAGE_BUY_MULTIPLIER;
        if (cash < positionUsd) {
          continue;
        }
        const shares = positionUsd / buyFill;
        const cost = shares * buyFill;
        if (cost > cash + 1e-6) {
          continue;
        }
        cash -= cost;
        const initialStop = buyFill - cfg.atrMultiplierBase * meta.entryAtr;
        positions.set(ticker, {
          entryDate: date,
          entryFillPrice: buyFill,
          shares,
          entryAtr: meta.entryAtr,
          currentStop: initialStop,
          highestCloseSinceEntry: Math.max(buyFill, bar.close),
        });
        pendingBuys.delete(ticker);
      }
    }

    const qqqBar = dayMap.get(BACKTEST_BENCHMARK_TICKER);
    if (qqqBar) {
      for (const [ticker, pos] of [...positions.entries()]) {
        const bar = dayMap.get(ticker);
        if (!bar) {
          continue;
        }
        if (bar.close <= pos.currentStop && !pendingExitReason.has(ticker)) {
          pendingExitReason.set(ticker, "TRAILING_STOP");
        }
      }
    }

    const inSignalWindow =
      compareIsoDate(date, fromDate) >= 0 && compareIsoDate(date, toDate) <= 0;

    const dow = isoWeekdayMon1ToFri5(date);
    const isRebalance = dow === cfg.rebalanceDayOfWeek;
    if (isRebalance && qqqBar && inSignalWindow) {
      const qqqSlice = sliceBarsThrough(qqqBars, date);
      const qqqCloses = qqqSlice?.map((b) => b.close) ?? [];
      const smaRegime = sma(cfg.smaPeriod, qqqCloses);
      const qqqRegimeOk = smaRegime !== null && qqqBar.close > smaRegime;

      if (qqqRegimeOk) {
        const priceMap = new Map<string, number[]>();
        for (const t of universe) {
          const series = byTicker.get(t);
          if (!series) {
            continue;
          }
          const slice = sliceBarsThrough(series, date);
          if (!slice || slice.length < cfg.lookbackDays) {
            continue;
          }
          priceMap.set(t, slice.map((b) => b.close));
        }

        const ranked = rankUniverse(priceMap, {
          lookbackDays: cfg.lookbackDays,
          skipDays: cfg.skipDays,
          topN: cfg.topN,
        });
        const topSet = new Set(ranked.slice(0, cfg.topN).map((r) => r.ticker));

        for (const [ticker] of [...positions.entries()]) {
          if (!topSet.has(ticker) && !pendingExitReason.has(ticker)) {
            pendingExitReason.set(ticker, "REBALANCE_DROP");
          }
        }

        const allowNewBuys = allowNewBuysForVixSession(date, options?.vixGate);
        if (allowNewBuys) {
          for (const t of ranked.slice(0, cfg.topN)) {
            if (positions.size + pendingBuys.size >= BACKTEST_MAX_CONCURRENT_POSITIONS) {
              break;
            }
            if (positions.has(t.ticker) || pendingBuys.has(t.ticker)) {
              continue;
            }
            const series = byTicker.get(t.ticker);
            if (!series) {
              continue;
            }
            const slice = sliceBarsThrough(series, date);
            if (!slice || slice.length < cfg.lookbackDays) {
              continue;
            }
            const highs = slice.map((b) => b.high);
            const lows = slice.map((b) => b.low);
            const closes = slice.map((b) => b.close);
            const entryAtrVal = atr(highs, lows, closes, cfg.atrPeriod);
            if (entryAtrVal === null) {
              continue;
            }
            pendingBuys.set(t.ticker, { entryAtr: entryAtrVal });
          }
        }
      }
    }

    for (const [ticker, pos] of [...positions.entries()]) {
      const bar = dayMap.get(ticker);
      if (!bar) {
        continue;
      }
      const nextHigh = Math.max(pos.highestCloseSinceEntry, bar.close);
      const series = byTicker.get(ticker);
      const slice = series ? sliceBarsThrough(series, date) : null;
      if (!slice || slice.length === 0) {
        continue;
      }
      const highs = slice.map((b) => b.high);
      const lows = slice.map((b) => b.low);
      const closes = slice.map((b) => b.close);
      const atrToday = atr(highs, lows, closes, cfg.atrPeriod);
      if (atrToday === null) {
        continue;
      }
      const newStop = computeTrailingStop(
        pos.currentStop,
        nextHigh,
        pos.entryFillPrice,
        atrToday,
        cfg.atrMultiplierBase,
        cfg.atrMultiplierTight,
        cfg.atrTightenThresholdPct,
      );
      positions.set(ticker, {
        ...pos,
        highestCloseSinceEntry: nextHigh,
        currentStop: newStop,
      });
    }

    for (const [ticker, pos] of [...positions.entries()]) {
      if (tradingDaysHeld(sortedTradingDates, pos.entryDate, date) >= cfg.maxHoldDays) {
        if (!pendingExitReason.has(ticker)) {
          pendingExitReason.set(ticker, "MAX_HOLD");
        }
      }
    }

    if (finalBacktestDate !== null && date === finalBacktestDate) {
      for (const [ticker, pos] of [...positions.entries()]) {
        const bar = dayMap.get(ticker);
        if (!bar) {
          continue;
        }
        const exitFill = bar.close * BACKTEST_SLIPPAGE_SELL_MULTIPLIER;
        closePosition(ticker, pos, date, exitFill, "FORCED_CLOSE");
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

function parseCli(): {
  from: string;
  to: string;
  strategy: "momentum" | "quality-garp" | "vix-momentum";
} {
  let from = "2021-01-01";
  let to = "2023-12-31";
  let strategy: "momentum" | "quality-garp" | "vix-momentum" = "momentum";
  let fromExplicit = false;
  let toExplicit = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from" && argv[i + 1]) {
      from = argv[++i]!;
      fromExplicit = true;
    } else if (a === "--to" && argv[i + 1]) {
      to = argv[++i]!;
      toExplicit = true;
    } else if (a === "--strategy" && argv[i + 1]) {
      const s = argv[++i]!;
      if (s === "quality-garp") {
        strategy = "quality-garp";
      } else if (s === "vix-momentum") {
        strategy = "vix-momentum";
      } else {
        strategy = "momentum";
      }
    }
  }
  if (strategy === "quality-garp") {
    if (!fromExplicit) {
      from = "2023-01-01";
    }
    if (!toExplicit) {
      to = "2025-12-31";
    }
  }
  if (strategy === "vix-momentum") {
    if (!fromExplicit) {
      from = "2022-01-01";
    }
    if (!toExplicit) {
      to = "2025-12-31";
    }
  }
  return { from, to, strategy };
}

function realOrZero(x: number | null): number {
  return x === null || Number.isNaN(x) ? 0 : x;
}

function closedTradeToDbExit(reason: ClosedBacktestTrade["exitReason"]): BacktestTradeExitReasonDb {
  switch (reason) {
    case "gapOrStop":
      return "TRAILING_STOP";
    case "maxHoldDays":
      return "TIME_EXIT";
    case "standardTakeProfit":
    case "standardTrendBreak":
      return "MANUAL";
    default:
      return "MANUAL";
  }
}

function backtestTradesTableExists(db: SqliteConnection): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backtest_trades' LIMIT 1`)
    .get() as { 1?: number } | undefined;
  return row !== undefined;
}

export function persistBacktestArtifacts(
  db: SqliteConnection,
  from: string,
  to: string,
  result: RunBacktestResult,
  strategy: string,
  windowLabel?: string,
  locked = 0,
): { runId: bigint; tradesInserted: number } {
  const expectancyPctPerTrade = mean(
    result.closedTrades.map((t) =>
      t.entryFillPrice !== 0
        ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
        : 0,
    ),
  );
  const runDate = new Date().toISOString().slice(0, 10);
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
    expectancy: realOrZero(expectancyPctPerTrade),
    strategy,
    windowLabel,
    locked,
  });

  let tradesInserted = 0;
  if (backtestTradesTableExists(db)) {
    for (const t of result.closedTrades) {
      const pnlPct =
        t.entryFillPrice !== 0
          ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
          : 0;
      insertBacktestTrade(db, {
        runRowid: lastInsertRowid,
        ticker: t.ticker,
        entryDate: t.entryDate,
        entryPrice: t.entryFillPrice,
        exitDate: t.exitDate,
        exitPrice: t.exitFillPrice,
        pnlPct,
        exitReason: closedTradeToDbExit(t.exitReason),
      });
      tradesInserted += 1;
    }
  }

  return { runId: lastInsertRowid, tradesInserted };
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");

if (isMain) {
  void (async () => {
  const { from, to, strategy } = parseCli();
  const config = getConfig();
  const db = new Database(config.DB_PATH);
  try {
    initSchema(db);

    if (strategy === "quality-garp") {
      const result = runQualityGarpBacktest(db, from, to);
      const expectancyPctPerTrade = mean(
        result.closedTrades.map((t) =>
          t.entryFillPrice !== 0
            ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
            : 0,
        ),
      );
      printQualityGarpSummary(from, to, result, expectancyPctPerTrade);

      if (result.metrics.totalTrades === 0 && result.equityPoints.length > 0) {
        console.warn(
          "Quality-GARP: 0 round-trip trades — regime gate, filters, or sparse EPS/quality snapshot vs price data.",
        );
      }

      const dbAbsPath = path.resolve(process.cwd(), config.DB_PATH);
      const { runId, tradesInserted } = persistBacktestArtifacts(db, from, to, result, "GARP_RESEARCH");
      console.log(
        `Saved backtest run to SQLite (id=${runId.toString()}, trades=${tradesInserted}, file=${dbAbsPath}).`,
      );
    } else if (strategy === "vix-momentum") {
      const { runVixMomentumSweep } = await import("./strategies/vix-momentum.js");
      await runVixMomentumSweep(db, from, to);
    } else {
      const result = runBacktest(db, from, to);
      const expectancyPctPerTrade = mean(
        result.closedTrades.map((t) =>
          t.entryFillPrice !== 0
            ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
            : 0,
        ),
      );
      const exitAgg = aggregateExitBuckets(result.closedTrades);
      printSummary(from, to, result.metrics, result.benchmarkCagrPct, expectancyPctPerTrade, exitAgg);

      if (result.metrics.totalTrades === 0 && result.equityPoints.length > 0) {
        console.warn(
          "Backtest: 0 round-trip trades — regime gate, ranking, or data window produced no fills.",
        );
      }

      const dbAbsPath = path.resolve(process.cwd(), config.DB_PATH);
      const { runId, tradesInserted } = persistBacktestArtifacts(db, from, to, result, "MOMENTUM");
      console.log(
        `Saved backtest run to SQLite (id=${runId.toString()}, trades=${tradesInserted}, file=${dbAbsPath}). Point sqlite-cue / other tools at this path.`,
      );
    }
  } finally {
    db.close();
  }
  })();
}
