import type { DailyBar } from "../shared/market-data-utils.js";
import { calendarYearFraction } from "../shared/date-utils.js";
import {
  lowerBoundInclusiveByDate,
  upperBoundInclusiveByDate,
} from "../shared/market-data-utils.js";
import {
  BACKTEST_ANNUAL_RISK_FREE_RATE,
  BACKTEST_TRADING_DAYS_PER_YEAR,
} from "./types.js";
import type {
  BacktestComputedMetrics,
  ClosedBacktestTrade,
  EquityPoint,
} from "./types.js";

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/**
 * Sample standard deviation (ddof = 1). Returns null if fewer than two values.
 */
function sampleStdDev(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 2) {
    return null;
  }
  const m = mean(values);
  let sq = 0;
  for (const v of values) {
    const d = v - m;
    sq += d * d;
  }
  return Math.sqrt(sq / (n - 1));
}

/**
 * Compound daily risk-free rate matching an annual rate with 252 trading days per year.
 */
export function dailyRiskFreeRateFromAnnual(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / BACKTEST_TRADING_DAYS_PER_YEAR) - 1;
}

/**
 * Simple returns between consecutive equity marks: (E_t / E_{t-1}) − 1.
 * Skips pairs where the prior equity is non-positive (caller should avoid such curves).
 */
export function equityMarksToDailyReturns(equityUsd: readonly number[]): number[] {
  if (equityUsd.length < 2) {
    return [];
  }
  const out: number[] = [];
  for (let i = 1; i < equityUsd.length; i++) {
    const prev = equityUsd[i - 1]!;
    const cur = equityUsd[i]!;
    if (prev > 0) {
      out.push(cur / prev - 1);
    }
  }
  return out;
}

export function equityPointsToDailyReturns(points: readonly EquityPoint[]): number[] {
  return equityMarksToDailyReturns(points.map((p) => p.equityUsd));
}

/**
 * CAGR in **percentage points** (e.g. 10.5 => 10.5% per year).
 * Uses total return factor (end / start) over the supplied calendar length in years.
 */
export function cagrPct(
  startEquity: number,
  endEquity: number,
  yearFraction: number,
): number | null {
  if (startEquity <= 0 || endEquity <= 0 || yearFraction <= 0) {
    return null;
  }
  const factor = endEquity / startEquity;
  if (factor <= 0) {
    return null;
  }
  return (Math.pow(factor, 1 / yearFraction) - 1) * 100;
}

/**
 * Maximum peak-to-trough decline along the equity curve, as **positive** percentage points
 * (e.g. 20 => a 20% drop from a prior peak). Null if there is no positive equity to anchor peaks.
 */
export function maxDrawdownPct(equityUsd: readonly number[]): number | null {
  if (equityUsd.length === 0) {
    return null;
  }
  let peak = 0;
  let maxDd = 0;
  for (const v of equityUsd) {
    if (v > peak) {
      peak = v;
    }
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100;
      if (dd > maxDd) {
        maxDd = dd;
      }
    }
  }
  if (peak <= 0) {
    return null;
  }
  return maxDd;
}

/** Peak/trough window that sets `maxDrawdownPct` on an equity curve. */
export function findMaxDrawdownWindow(
  points: readonly EquityPoint[],
): { peakDate: string; troughDate: string; peakNav: number; troughNav: number; drawdownPct: number } | null {
  if (points.length === 0) {
    return null;
  }
  let peakNav = 0;
  let peakDate = points[0]!.date;
  let maxDd = 0;
  let troughDate = points[0]!.date;
  let troughNav = points[0]!.equityUsd;
  let bestPeakDate = peakDate;
  let bestPeakNav = peakNav;

  for (const p of points) {
    if (p.equityUsd > peakNav) {
      peakNav = p.equityUsd;
      peakDate = p.date;
    }
    if (peakNav > 0) {
      const dd = ((peakNav - p.equityUsd) / peakNav) * 100;
      if (dd > maxDd) {
        maxDd = dd;
        troughDate = p.date;
        troughNav = p.equityUsd;
        bestPeakDate = peakDate;
        bestPeakNav = peakNav;
      }
    }
  }
  if (peakNav <= 0) {
    return null;
  }
  return {
    peakDate: bestPeakDate,
    troughDate,
    peakNav: bestPeakNav,
    troughNav,
    drawdownPct: maxDd,
  };
}

/**
 * Win rate in percentage points. Null when there are no closed trades.
 */
export function winRatePct(closedTrades: readonly ClosedBacktestTrade[]): number | null {
  const n = closedTrades.length;
  if (n === 0) {
    return null;
  }
  let wins = 0;
  for (const t of closedTrades) {
    if (t.realizedPnlUsd > 0) {
      wins += 1;
    }
  }
  return (wins / n) * 100;
}

/**
 * Annualized Sharpe from **daily** simple returns: sqrt(252) × mean(excess) / σ(excess).
 * `annualRiskFreeRate` is a decimal annual rate (default 4% = 0.04).
 * Null if there are fewer than two returns or zero volatility.
 */
export function sharpeRatioAnnualized(
  dailySimpleReturns: readonly number[],
  annualRiskFreeRate: number = BACKTEST_ANNUAL_RISK_FREE_RATE,
): number | null {
  if (dailySimpleReturns.length < 2) {
    return null;
  }
  const rfDaily = dailyRiskFreeRateFromAnnual(annualRiskFreeRate);
  const excess = dailySimpleReturns.map((r) => r - rfDaily);
  const sigma = sampleStdDev(excess);
  if (sigma === null || sigma === 0) {
    return null;
  }
  const muExcess = mean(excess);
  return (
    (muExcess / sigma) * Math.sqrt(BACKTEST_TRADING_DAYS_PER_YEAR)
  );
}

// ── Shared backtest position type ──────────────────────────────────────────

/** A simulated position held during the backtest day loop. */
export interface SimPosition {
  entryDate: string;
  entryFillPrice: number;
  shares: number;
  entryAtr: number;
  currentStop: number;
  highestCloseSinceEntry: number;
}

// ── Shared formatting helpers ──────────────────────────────────────────────

/** Format a nullable number as a percentage string (or "n/a"). */
export function fmtPct(x: number | null, digits = 2): string {
  if (x === null || Number.isNaN(x)) {
    return "n/a";
  }
  return `${x.toFixed(digits)}%`;
}

/** Format a nullable number as a decimal string (or "n/a"). */
export function fmtNum(x: number | null, digits = 3): string {
  if (x === null || Number.isNaN(x)) {
    return "n/a";
  }
  return x.toFixed(digits);
}

// ── Shared benchmark CAGR helper ───────────────────────────────────────────

/**
 * Compute buy-and-hold CAGR for the benchmark index (QQQ) over the
 * backtest window.  Used by both momentum and GARP simulations.
 */
export function benchmarkBuyHoldCagrPct(
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

// ── Shared exit-reason types and helpers ──────────────────────────────────

/** Strategy exit reasons tracked in the exit-bucket breakdown. */
export type BacktestStrategyExitReason =
  | "TRAILING_STOP"
  | "MAX_HOLD"
  | "REBALANCE_DROP"
  | "FORCED_CLOSE";

/** Map a strategy exit reason to the canonical ClosedBacktestTrade exit-reason label. */
export function toBacktestExitReason(r: BacktestStrategyExitReason): ClosedBacktestTrade["exitReason"] {
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

/** Inverse of toBacktestExitReason: map a DB exit reason back to a strategy label. */
export function strategyBucketFromClosedTrade(t: ClosedBacktestTrade): BacktestStrategyExitReason {
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
export function calendarHoldDaysHeld(entryDate: string, exitDate: string): number {
  return (new Date(exitDate).getTime() - new Date(entryDate).getTime()) / (1000 * 60 * 60 * 24);
}

/** Aggregated stats for a single exit-reason bucket. */
export interface BacktestExitBucketAgg {
  count: number;
  sumPnlPct: number;
  sumHoldDays: number;
}

function emptyExitBucketAgg(): Record<BacktestStrategyExitReason, BacktestExitBucketAgg> {
  return {
    TRAILING_STOP: { count: 0, sumPnlPct: 0, sumHoldDays: 0 },
    MAX_HOLD: { count: 0, sumPnlPct: 0, sumHoldDays: 0 },
    REBALANCE_DROP: { count: 0, sumPnlPct: 0, sumHoldDays: 0 },
    FORCED_CLOSE: { count: 0, sumPnlPct: 0, sumHoldDays: 0 },
  };
}

/** Aggregate closed trades into exit-reason buckets for the summary breakdown. */
export function aggregateExitBuckets(
  closedTrades: readonly ClosedBacktestTrade[],
): Record<BacktestStrategyExitReason, BacktestExitBucketAgg> {
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

// ── Shared print summary ──────────────────────────────────────────────────

/** Aggregated stats for a single exit-reason bucket. */
export interface BacktestExitBucketAgg {
  count: number;
  sumPnlPct: number;
  sumHoldDays: number;
}

export interface PrintBacktestSummaryOptions {
  /** If set, a "Strategy" row is prepended to the metric table. */
  readonly label?: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly metrics: BacktestComputedMetrics;
  readonly benchmarkCagrPct: number | null;
  readonly expectancyPctPerTrade: number | null;
  /**
   * Optional exit-bucket breakdown. When provided, a per-bucket table is
   * printed below the main metrics. Keys are exit-reason labels (e.g.
   * "TRAILING_STOP", "MAX_HOLD", "REBALANCE_DROP", "FORCED_CLOSE").
   */
  readonly exitBuckets?: Record<string, BacktestExitBucketAgg>;
}

/**
 * Print a formatted backtest summary table to stdout.
 * Used by both the momentum runner and the GARP strategy module.
 */
export function printBacktestSummary(opts: PrintBacktestSummaryOptions): void {
  const ticker = "QQQ";
  const rows: [string, string][] = [];

  if (opts.label !== undefined) {
    rows.push(["Strategy", opts.label]);
  }
  rows.push(
    ["Window", `${opts.fromDate} → ${opts.toDate}`],
    ["CAGR (strategy)", fmtPct(opts.metrics.cagrPct)],
    ["Max drawdown", fmtPct(opts.metrics.maxDrawdownPct)],
    ["Win rate", fmtPct(opts.metrics.winRatePct)],
    ["Sharpe (ann.)", fmtNum(opts.metrics.sharpeRatio)],
    ["Expectancy (avg P&L % / trade)", fmtPct(opts.expectancyPctPerTrade, 3)],
    ["Total trades", String(opts.metrics.totalTrades)],
    [`Benchmark (${ticker}) CAGR`, fmtPct(opts.benchmarkCagrPct)],
  );

  const labelW = Math.max(...rows.map(([a]) => a.length));
  console.log("");
  console.log("Cue backtest");
  console.log("-".repeat(Math.max(40, labelW + 28)));
  for (const [label, value] of rows) {
    console.log(`${label.padEnd(labelW)}  ${value}`);
  }
  console.log("-".repeat(Math.max(40, labelW + 28)));
  console.log("");

  if (opts.exitBuckets !== undefined) {
    const keys = ["TRAILING_STOP", "MAX_HOLD", "REBALANCE_DROP", "FORCED_CLOSE"] as const;
    console.log("");
    console.log("Exit bucket breakdown (strategy labels):");
    for (const k of keys) {
      const bucket = opts.exitBuckets[k];
      if (bucket === undefined) {
        continue;
      }
      const { count, sumPnlPct, sumHoldDays } = bucket;
      const avgPnl = count > 0 ? sumPnlPct / count : 0;
      const avgHold = count > 0 ? sumHoldDays / count : 0;
      console.log(
        `  ${k.padEnd(18)} ${count.toString().padEnd(4)} | Avg P&L: ${avgPnl.toFixed(2)}% | Avg Hold: ${avgHold.toFixed(1)} days`,
      );
    }
  }

  console.log("");
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ComputeBacktestMetricsInput {
  /** Ordered trading-day equity marks (same order as dates used for returns / drawdown). */
  equityPoints: readonly EquityPoint[];
  closedTrades: readonly ClosedBacktestTrade[];
  /** Calendar span in years for CAGR, e.g. days / 365.25 from backtest window. */
  yearFraction: number;
  annualRiskFreeRate?: number;
}

/**
 * Convenience bundle for the runner: CAGR / max DD / win rate / Sharpe / trade count.
 * CAGR uses first and last equity; Sharpe uses simple daily returns between consecutive marks.
 */
export function computeBacktestMetrics(input: ComputeBacktestMetricsInput): BacktestComputedMetrics {
  const marks = input.equityPoints.map((p) => p.equityUsd);
  const first = marks[0];
  const last = marks.length > 0 ? marks[marks.length - 1]! : undefined;
  const dailyReturns = equityPointsToDailyReturns(input.equityPoints);

  const cagr =
    first !== undefined &&
    last !== undefined &&
    first > 0 &&
    last > 0 &&
    input.yearFraction > 0
      ? cagrPct(first, last, input.yearFraction)
      : null;

  return {
    cagrPct: cagr,
    maxDrawdownPct: maxDrawdownPct(marks),
    winRatePct: winRatePct(input.closedTrades),
    sharpeRatio: sharpeRatioAnnualized(
      dailyReturns,
      input.annualRiskFreeRate ?? BACKTEST_ANNUAL_RISK_FREE_RATE,
    ),
    totalTrades: input.closedTrades.length,
  };
}
