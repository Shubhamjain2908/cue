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
