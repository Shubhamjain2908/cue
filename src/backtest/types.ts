/**
 * Backtest simulation & reporting types (Cue spec §7.2–7.3, Phase 1 gates §15).
 * Constants are used by the day-by-day runner; metric shapes are produced by `metrics.ts`.
 */

import { getConfig } from "../config/index.js";

/** Time-based exit: trading days after entry before force-exit at next open (from `MAX_HOLD_DAYS` env). */
export const BACKTEST_MAX_HOLD_DAYS: number = getConfig().MAX_HOLD_DAYS;

/** §7.2 — fixed USD notional per concurrent position. */
export const BACKTEST_POSITION_USD = 400;

/** §7.2 — 0.1% adverse slippage on each leg at the open. */
export const BACKTEST_SLIPPAGE_BUY_MULTIPLIER = 1.001;
export const BACKTEST_SLIPPAGE_SELL_MULTIPLIER = 0.999;

/** §7.2 — cap on simultaneous open positions in simulation. */
export const BACKTEST_MAX_CONCURRENT_POSITIONS = 5;

/**
 * §7.2 / §6.3 — nominal stop is entry × (1 − fraction).
 * Gap-down rule: if T+1 open is already at or below that level, exit at the open.
 */
export const BACKTEST_STOP_LOSS_FRACTION = 0.05;

/** Increment 3 default — annual risk-free rate for Sharpe (decimal, e.g. 0.04 = 4%). */
export const BACKTEST_ANNUAL_RISK_FREE_RATE = 0.04;

/** Trading days per year for annualizing Sharpe from daily returns. */
export const BACKTEST_TRADING_DAYS_PER_YEAR = 252;

/** One point on the simulated mark-to-market equity curve (runner fills this day-by-day). */
export interface EquityPoint {
  date: string;
  /** Total portfolio equity in USD after applying that day’s opens/closes and MTM. */
  equityUsd: number;
}

/** Exit path at next open (see `runBacktest` priority chain). */
export type BacktestExitReason =
  | "gapOrStop"
  | "maxHoldDays"
  | "standardTakeProfit"
  | "standardTrendBreak";

/** A completed round-trip from the simulator (win rate uses `realizedPnlUsd`). */
export interface ClosedBacktestTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  /** Cash P&L for this position after slippage, vs flat cash baseline (not annualized). */
  realizedPnlUsd: number;
  /** Fills used for round-trip % diagnostics (slippage-adjusted opens). */
  exitReason: BacktestExitReason;
  entryFillPrice: number;
  exitFillPrice: number;
}

/** Values aligned with `backtest_runs` / CLI output: rates as percentage points (e.g. 12.3 = 12.3%). */
export interface BacktestComputedMetrics {
  cagrPct: number | null;
  maxDrawdownPct: number | null;
  winRatePct: number | null;
  sharpeRatio: number | null;
  totalTrades: number;
}
