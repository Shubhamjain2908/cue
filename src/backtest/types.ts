/**
 * Backtest simulation & reporting types (Cue spec §7.2–7.3, Phase 1 gates §15).
 * Constants are used by the day-by-day runner; metric shapes are produced by `metrics.ts`.
 */

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

/** Default initial cash for backtest simulations. */
export const BACKTEST_INITIAL_CASH_USD = 2500;

/** Calendar days to pull before `fromDate` for momentum / SMA / ATR windows. */
export const BACKTEST_WARMUP_CALENDAR_DAYS = 550;

/** Calendar days after `toDate` to simulate pending fills through settlement extension. */
export const BACKTEST_SETTLEMENT_EXTENSION_CALENDAR_DAYS = 45;

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

/** Bundle returned by momentum and research strategy simulators. */
export interface RunBacktestResult {
  equityPoints: EquityPoint[];
  closedTrades: ClosedBacktestTrade[];
  metrics: BacktestComputedMetrics;
  benchmarkCagrPct: number | null;
  yearFraction: number;
}

/** `backtest_runs.strategy` label for P7-G VIX threshold sweep (research only). */
export const VIX_MOMENTUM_RESEARCH_STRATEGY = "VIX_MOMENTUM_RESEARCH";

/** VIX ceilings tested by `runVixMomentumSweep` (stacked on QQQ SMA200). */
export const VIX_MOMENTUM_THRESHOLDS = [25, 28, 30, 35] as const;

export type VixMomentumThreshold = (typeof VIX_MOMENTUM_THRESHOLDS)[number];

/** Phase 1 / extended-window gates for comparing sweep rows. */
export interface BacktestGateThresholds {
  minCagrPct: number;
  maxDrawdownPct: number;
  minSharpe: number;
  minExpectancyPct: number;
}

export const DEFAULT_BACKTEST_GATES: BacktestGateThresholds = {
  minCagrPct: 12,
  maxDrawdownPct: 20,
  minSharpe: 1.0,
  minExpectancyPct: 0,
};

/**
 * Optional stacked regime gate for momentum backtest (P7-G).
 * When set, new BUYs on rebalance require `VIX_close <= maxVix` in addition to QQQ > SMA200.
 */
export interface VixRegimeGate {
  vixByDate: ReadonlyMap<string, number>;
  maxVix: number;
}

export interface MomentumBacktestOptions {
  vixGate?: VixRegimeGate;
}
