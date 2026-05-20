/**
 * Isolated Quality–GARP factor overlay backtest (research only).
 * Does not read or write `signals` / production screeners.
 *
 * Data: `daily_prices` (SQLite), `data/fundamentals/eps_history_20260520.json`,
 * `data/fundamentals/quality_snapshot_20260520.json`. Does not read `fundamentals_cache`.
 */

import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { computeTrailingStop } from "../../analysers/ranker.js";
import { getConfig } from "../../config/index.js";
import { atr, sma } from "../../enrichers/indicators.js";
import { DEFAULT_RANKING_CONFIG } from "../../enrichers/momentum-types.js";
import { computeBacktestMetrics, cagrPct } from "../metrics.js";
import type { ClosedBacktestTrade, EquityPoint, RunBacktestResult } from "../types.js";
import {
  BACKTEST_SLIPPAGE_BUY_MULTIPLIER,
  BACKTEST_SLIPPAGE_SELL_MULTIPLIER,
  BACKTEST_POSITION_USD,
} from "../types.js";
import { loadUniverseTickers } from "../../universe/load-universe.js";

type SqliteConnection = InstanceType<typeof Database>;

const BENCHMARK_TICKER = "QQQ";

const INITIAL_CASH_USD = 2500;
const WARMUP_CALENDAR_DAYS = 550;
const SETTLEMENT_EXTENSION_CALENDAR_DAYS = 45;

const GARP_TOP_N = 3;
const GARP_MAX_CONCURRENT = 3;

const DEFAULT_EPS_HISTORY = "data/fundamentals/eps_history_20260520.json";
const DEFAULT_QUALITY_SNAPSHOT = "data/fundamentals/quality_snapshot_20260520.json";

type StrategyExitReason = "TRAILING_STOP" | "MAX_HOLD" | "FORCED_CLOSE";

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

type EpsHistoryFile = Record<string, Record<string, number>>;

/** Parsed FYE row with numeric fields (from `quality_snapshot_*.json`). */
interface QualityBalanceSheetRow {
  netIncome: number;
  totalEquity: number;
  totalDebt: number;
}

type QualitySnapshotFile = Record<string, Record<string, unknown>>;

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

/** 1 = Monday … 5 = Friday (matches `runner.ts`). */
function isoWeekdayMon1ToFri5(iso: string): number {
  const dow = new Date(parseIsoUtcMs(iso)).getUTCDay();
  if (dow === 0 || dow === 6) {
    return 0;
  }
  return dow;
}

function calendarYearFraction(fromIso: string, toIso: string): number {
  const raw = (parseIsoUtcMs(toIso) - parseIsoUtcMs(fromIso)) / 86_400_000 / 365.25;
  return Math.max(raw, 1e-9);
}

function calendarDaysHeld(entryDate: string, asOf: string): number {
  return Math.floor((parseIsoUtcMs(asOf) - parseIsoUtcMs(entryDate)) / 86_400_000);
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
    .all(BENCHMARK_TICKER, dateFrom, dateTo) as { date: string }[];
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

function qualityBookForTicker(
  snap: QualitySnapshotFile,
  ticker: string,
): Record<string, unknown> | undefined {
  const u = ticker.toUpperCase();
  const book = snap[u] ?? snap[ticker];
  return book !== undefined && typeof book === "object" && book !== null ? (book as Record<string, unknown>) : undefined;
}

function qualityRowHasNumericBalanceSheet(r: unknown): r is QualityBalanceSheetRow {
  if (r === null || typeof r !== "object") {
    return false;
  }
  const o = r as Record<string, unknown>;
  const ni = o.netIncome;
  const eq = o.totalEquity;
  const td = o.totalDebt;
  return (
    typeof ni === "number" &&
    Number.isFinite(ni) &&
    typeof eq === "number" &&
    Number.isFinite(eq) &&
    eq > 0 &&
    typeof td === "number" &&
    Number.isFinite(td)
  );
}

/**
 * Balance-sheet row aligned to EPS `epsNowDate`, or latest prior FYE with usable numbers.
 */
function pickQualityRowForEpsFye(
  snap: QualitySnapshotFile,
  ticker: string,
  epsNowDate: string,
): QualityBalanceSheetRow | null {
  const book = qualityBookForTicker(snap, ticker);
  if (!book) {
    return null;
  }
  const direct = book[epsNowDate];
  if (direct !== undefined && qualityRowHasNumericBalanceSheet(direct)) {
    return direct;
  }
  const dates = Object.keys(book)
    .filter((d) => compareIsoDate(d, epsNowDate) <= 0)
    .sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const row = book[dates[i]!]!;
    if (qualityRowHasNumericBalanceSheet(row)) {
      return row;
    }
  }
  return null;
}

function pickEpsPair(
  epsByTicker: EpsHistoryFile,
  ticker: string,
  simDate: string,
): { epsNow: number; epsNowDate: string; eps3Y: number; eps3YDate: string } | null {
  const book = epsByTicker[ticker.toUpperCase()] ?? epsByTicker[ticker];
  if (!book || typeof book !== "object") {
    return null;
  }
  const tCut = addCalendarDays(simDate, -90);
  const fyDates = Object.keys(book).sort();
  const available = fyDates.filter((d) => compareIsoDate(d, tCut) < 0);
  if (available.length === 0) {
    return null;
  }
  const epsNowDate = available[available.length - 1]!;
  const epsNow = book[epsNowDate];
  if (epsNow === undefined || typeof epsNow !== "number" || epsNow <= 0) {
    return null;
  }

  const targetMs = parseIsoUtcMs(addCalendarDays(epsNowDate, -1095));
  let bestDate: string | null = null;
  let bestDist = Infinity;
  for (const d of fyDates) {
    if (compareIsoDate(d, epsNowDate) >= 0) {
      continue;
    }
    const dist = Math.abs(parseIsoUtcMs(d) - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      bestDate = d;
    }
  }
  if (bestDate === null) {
    return null;
  }
  const eps3Y = book[bestDate];
  if (eps3Y === undefined || typeof eps3Y !== "number" || eps3Y <= 0) {
    return null;
  }

  const gapDays = bestDist / 86_400_000;
  if (gapDays > 540) {
    return null;
  }

  return { epsNow, epsNowDate, eps3Y, eps3YDate: bestDate };
}

interface PegCandidate {
  ticker: string;
  peg: number;
}

function computePegSurvivors(
  universe: readonly string[],
  simDate: string,
  byTicker: Map<string, DailyBar[]>,
  epsHistory: EpsHistoryFile,
  qualitySnapshot: QualitySnapshotFile,
): PegCandidate[] {
  const out: PegCandidate[] = [];
  for (const t of universe) {
    const series = byTicker.get(t.toUpperCase());
    if (!series) {
      continue;
    }
    const closePx = closeMarkAsOf(series, simDate);
    if (closePx === null || closePx <= 0) {
      continue;
    }

    const epsPair = pickEpsPair(epsHistory, t, simDate);
    if (!epsPair) {
      continue;
    }

    const qRow = pickQualityRowForEpsFye(qualitySnapshot, t, epsPair.epsNowDate);
    if (!qRow) {
      continue;
    }

    const roe = qRow.netIncome / qRow.totalEquity;
    const debtEquityRatio = qRow.totalDebt / qRow.totalEquity;
    if (!Number.isFinite(roe) || roe < 0.15) {
      continue;
    }
    if (!Number.isFinite(debtEquityRatio) || debtEquityRatio > 1.5) {
      continue;
    }

    const peTtm = closePx / epsPair.epsNow;
    if (!Number.isFinite(peTtm) || peTtm <= 0) {
      continue;
    }

    const ratio = epsPair.epsNow / epsPair.eps3Y;
    const deltaEps3y = Math.pow(ratio, 1 / 3) - 1;
    if (deltaEps3y <= 0 || !Number.isFinite(deltaEps3y)) {
      continue;
    }

    const peg = peTtm / (deltaEps3y * 100);
    if (!Number.isFinite(peg) || peg <= 0) {
      continue;
    }

    out.push({ ticker: t.toUpperCase(), peg });
  }

  out.sort((a, b) => a.peg - b.peg);
  return out.slice(0, GARP_TOP_N);
}

function toBacktestExitReason(r: StrategyExitReason): ClosedBacktestTrade["exitReason"] {
  switch (r) {
    case "TRAILING_STOP":
      return "gapOrStop";
    case "MAX_HOLD":
      return "maxHoldDays";
    case "FORCED_CLOSE":
      return "standardTakeProfit";
  }
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
  label: string,
  fromDate: string,
  toDate: string,
  metrics: ReturnType<typeof computeBacktestMetrics>,
  benchmarkCagrPct: number | null,
  expectancyPctPerTrade: number | null,
): void {
  const rows: [string, string][] = [
    ["Strategy", label],
    ["Window", `${fromDate} → ${toDate}`],
    ["CAGR (strategy)", fmtPct(metrics.cagrPct)],
    ["Max drawdown", fmtPct(metrics.maxDrawdownPct)],
    ["Win rate", fmtPct(metrics.winRatePct)],
    ["Sharpe (ann.)", fmtNum(metrics.sharpeRatio)],
    ["Expectancy (avg P&L % / trade)", fmtPct(expectancyPctPerTrade, 3)],
    ["Total trades", String(metrics.totalTrades)],
    [`Benchmark (${BENCHMARK_TICKER}) CAGR`, fmtPct(benchmarkCagrPct)],
  ];
  const labelW = Math.max(...rows.map(([a]) => a.length));
  console.log("");
  console.log("Cue backtest");
  console.log("-".repeat(Math.max(40, labelW + 28)));
  for (const [lab, value] of rows) {
    console.log(`${lab.padEnd(labelW)}  ${value}`);
  }
  console.log("-".repeat(Math.max(40, labelW + 28)));
  console.log("");
}

function loadEpsHistory(filePath: string): EpsHistoryFile {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw) as EpsHistoryFile;
}

function loadQualitySnapshot(filePath: string): QualitySnapshotFile {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw) as QualitySnapshotFile;
}

export interface RunQualityGarpBacktestOpts {
  /** Defaults to `data/fundamentals/eps_history_20260520.json` under cwd. */
  readonly epsHistoryPath?: string;
  /** Defaults to `data/fundamentals/quality_snapshot_20260520.json` under cwd. */
  readonly qualitySnapshotPath?: string;
}

/**
 * Weekly Friday Quality–GARP simulation: QQQ SMA(200) gate, PEG ranking, ATR trailing stops.
 * Never touches `signals`.
 */
export function runQualityGarpBacktest(
  db: SqliteConnection,
  fromDate: string,
  toDate: string,
  opts: RunQualityGarpBacktestOpts = {},
): RunBacktestResult {
  if (compareIsoDate(fromDate, toDate) > 0) {
    throw new Error(`runQualityGarpBacktest: fromDate ${fromDate} is after toDate ${toDate}`);
  }

  const cfg = DEFAULT_RANKING_CONFIG;
  const appCfg = getConfig();
  const positionUsd = appCfg.POSITION_SIZE_USD ?? BACKTEST_POSITION_USD;
  const maxHoldCalendarDays = appCfg.MAX_HOLD_DAYS;

  const epsPath = opts.epsHistoryPath ?? DEFAULT_EPS_HISTORY;
  let epsHistory: EpsHistoryFile;
  try {
    epsHistory = loadEpsHistory(epsPath);
  } catch (e) {
    throw new Error(
      `Quality-GARP: failed to load EPS history from ${epsPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const qualityPath = opts.qualitySnapshotPath ?? DEFAULT_QUALITY_SNAPSHOT;
  let qualitySnapshot: QualitySnapshotFile;
  try {
    qualitySnapshot = loadQualitySnapshot(qualityPath);
  } catch (e) {
    throw new Error(
      `Quality-GARP: failed to load quality snapshot from ${qualityPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const universe = loadUniverseTickers();
  const allTickers = [...new Set([...universe, BENCHMARK_TICKER])].sort((a, b) => a.localeCompare(b));

  const dataFrom = addCalendarDays(fromDate, -WARMUP_CALENDAR_DAYS);
  const dataTo = addCalendarDays(toDate, SETTLEMENT_EXTENSION_CALENDAR_DAYS);
  const rows = hydrateDailyPrices(db, allTickers, dataFrom, dataTo);

  const byTicker = indexByTicker(rows);
  const byDate = indexByDate(rows);
  const sortedTradingDates = loadQqqTradingDates(db, dataFrom, dataTo);

  const qqqSeries = byTicker.get(BENCHMARK_TICKER);
  if (!qqqSeries) {
    throw new Error(`${BENCHMARK_TICKER} not found in daily_prices — required for calendar and regime filter`);
  }
  const qqqBars = qqqSeries;
  const yearFraction = calendarYearFraction(fromDate, toDate);
  const benchmarkCagrPct = benchmarkBuyHoldCagrPct(qqqBars, fromDate, toDate);

  let cash = INITIAL_CASH_USD;
  const positions = new Map<string, SimPosition>();
  const pendingExitReason = new Map<string, StrategyExitReason>();

  const equityPoints: EquityPoint[] = [];
  const closedTrades: ClosedBacktestTrade[] = [];

  const datesLeqTo = sortedTradingDates.filter((d) => compareIsoDate(d, toDate) <= 0);
  const finalBacktestDate = datesLeqTo.length > 0 ? datesLeqTo[datesLeqTo.length - 1]! : null;

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
    }

    const qqqBar = dayMap.get(BENCHMARK_TICKER);
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
      const regimeOk = smaRegime !== null && qqqBar.close > smaRegime;

      if (regimeOk) {
        const picks = computePegSurvivors(universe, date, byTicker, epsHistory, qualitySnapshot);

        for (const p of picks) {
          if (positions.size >= GARP_MAX_CONCURRENT) {
            break;
          }
          if (positions.has(p.ticker) || pendingExitReason.has(p.ticker)) {
            continue;
          }
          const series = byTicker.get(p.ticker);
          if (!series) {
            continue;
          }
          const bar = dayMap.get(p.ticker);
          if (!bar) {
            continue;
          }
          const entryFill = bar.close * BACKTEST_SLIPPAGE_BUY_MULTIPLIER;
          if (cash < positionUsd) {
            break;
          }
          const shares = positionUsd / entryFill;
          const cost = shares * entryFill;
          if (cost > cash + 1e-6) {
            break;
          }
          const slice = sliceBarsThrough(series, date);
          if (!slice || slice.length < cfg.atrPeriod + 1) {
            continue;
          }
          const highs = slice.map((b) => b.high);
          const lows = slice.map((b) => b.low);
          const closes = slice.map((b) => b.close);
          const entryAtrVal = atr(highs, lows, closes, cfg.atrPeriod);
          if (entryAtrVal === null) {
            continue;
          }
          cash -= cost;
          const initialStop = entryFill - cfg.atrMultiplierBase * entryAtrVal;
          positions.set(p.ticker, {
            entryDate: date,
            entryFillPrice: entryFill,
            shares,
            entryAtr: entryAtrVal,
            currentStop: initialStop,
            highestCloseSinceEntry: Math.max(entryFill, bar.close),
          });
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
      if (calendarDaysHeld(pos.entryDate, date) >= maxHoldCalendarDays) {
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

export function printQualityGarpGateLine(
  metrics: ReturnType<typeof computeBacktestMetrics>,
  expectancyPctPerTrade: number | null,
): void {
  const sharpeOk = metrics.sharpeRatio !== null && metrics.sharpeRatio > 0.8;
  const expOk = expectancyPctPerTrade !== null && expectancyPctPerTrade > 0;
  const pass = sharpeOk && expOk;
  console.log(
    `Quality-GARP production gate: Sharpe>0.8 (${sharpeOk ? "PASS" : "FAIL"}), Expectancy>0 (${expOk ? "PASS" : "FAIL"}) → ${pass ? "CLEAR" : "BLOCKED"}`,
  );
  console.log("");
}

export function printQualityGarpSummary(
  fromDate: string,
  toDate: string,
  result: RunBacktestResult,
  expectancyPctPerTrade: number | null,
): void {
  printSummary("quality-garp (research)", fromDate, toDate, result.metrics, result.benchmarkCagrPct, expectancyPctPerTrade);
  printQualityGarpGateLine(result.metrics, expectancyPctPerTrade);
}
