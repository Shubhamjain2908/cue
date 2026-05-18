/**
 * Shared signal types. Macro regime (QQQ SMA200 hard gate on new BUYs) lives in
 * `signals.ts` (`decideSide` / `generateSignal` and `GenerateSignalInput`).
 */
export type TradeSignal = "BUY" | "SELL" | "HOLD";

/** Present on `signal: "SELL"` from `decideSide` / `generateSignal` when exiting an open position. */
export type SignalExitReason = "TAKE_PROFIT" | "TREND_BREAK";

export interface SignalThresholds {
  smaPeriod: number; // Short SMA period (default: 50)
  buyRsiMax: number; // RSI ceiling for pullback entry (default: 60)
  buyVolumeRatio: number; // Min 20d/60d volume ratio at entry (default: 1.2)
  exitRsiThreshold: number; // RSI take-profit ceiling (default: 70)
  stopLossPct: number; // Hard stop % below entry (default: 5)
  maxHoldDays: number; // Time-based exit in trading days (default: 20)
}

export const DEFAULT_SIGNAL_THRESHOLDS: SignalThresholds = {
  smaPeriod: 50,
  buyRsiMax: 60,
  buyVolumeRatio: 1.2,
  exitRsiThreshold: 75,
  stopLossPct: 5,
  maxHoldDays: 40,
};

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
