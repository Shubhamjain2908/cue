/**
 * Shared signal types. Macro regime (QQQ SMA200 hard gate on new BUYs) lives in
 * `signals.ts` (`decideSide` / `generateSignal` and `GenerateSignalInput`).
 */

// RETIRED: SignalThresholds (RSI/volume exhaustion entry) — do not use in backtest
// ACTIVE: RankingConfig (Cross-Sectional Momentum, per §6.2 spec)

export type TradeSignal = "BUY" | "SELL" | "HOLD";

/** Present on `signal: "SELL"` from `decideSide` / `generateSignal` when exiting an open position. */
export type SignalExitReason = "TAKE_PROFIT" | "TREND_BREAK";

/**
 * @deprecated Legacy RSI / volume gate surface still consumed by `config` and `signals.ts`.
 * Prefer `RankingConfig` / `DEFAULT_RANKING_CONFIG` for the momentum backtest.
 */
export interface SignalThresholds {
  smaPeriod: number; // Short SMA period (default: 50)
  buyRsiMax: number; // RSI ceiling for pullback entry (default: 60)
  buyVolumeRatio: number; // Min 20d/60d volume ratio at entry (default: 1.2)
  exitRsiThreshold: number; // RSI take-profit ceiling (default: 70)
  stopLossPct: number; // Hard stop % below entry (default: 5)
  maxHoldDays: number; // Time-based exit in trading days (default: 20)
}

/** @deprecated See `DEFAULT_RANKING_CONFIG` for the active strategy defaults. */
export const DEFAULT_SIGNAL_THRESHOLDS: SignalThresholds = {
  smaPeriod: 50,
  buyRsiMax: 60,
  buyVolumeRatio: 1.2,
  exitRsiThreshold: 70,
  stopLossPct: 5,
  maxHoldDays: 20,
};

export interface RankingConfig {
  lookbackDays: number; // default: 252  (12 months)
  skipDays: number; // default: 21   (1 month skip — avoids mean reversion)
  topN: number; // default: 5
  rebalanceDayOfWeek: number; // default: 5    (1=Mon … 5=Fri)
  // Risk management (per §6.3)
  atrPeriod: number; // default: 14
  atrMultiplierBase: number; // default: 2.0
  atrMultiplierTight: number; // default: 1.5
  atrTightenThresholdPct: number; // default: 15.0
  maxHoldDays: number; // default: 40   (circuit breaker only)
  smaPeriod: number; // default: 200  (QQQ regime gate only)
}

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  lookbackDays: 252,
  skipDays: 21,
  topN: 5,
  rebalanceDayOfWeek: 5,
  atrPeriod: 14,
  atrMultiplierBase: 2.0,
  atrMultiplierTight: 1.5,
  atrTightenThresholdPct: 15.0,
  maxHoldDays: 40,
  smaPeriod: 200,
};

export interface RankedTicker {
  ticker: string;
  momentumReturn: number; // raw 12-1 score
  rank: number; // 1 = highest momentum
}

export interface OpenPosition {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  entryAtr: number;
  currentStop: number;
  highestCloseSinceEntry: number;
  daysHeld: number;
}

export interface OpenPositionContext {
  entryPrice: number;
}

export interface SignalMetrics {
  rsi14: number | null;
  momentum5dPct: number | null;
  volumeRatio: number | null;
  lastClose: number | null;
}

export interface SignalDecision {
  signal: TradeSignal;
  metrics: SignalMetrics;
  /** Set when `signal === "SELL"` from the exit path (RSI take-profit vs SMA trend-break). */
  reason?: SignalExitReason;
}
