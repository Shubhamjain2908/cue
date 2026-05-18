export type TradeSignal = "BUY" | "SELL" | "HOLD";

export interface SignalThresholds {
  // Trend filter
  smaPeriod: number; // SMA period for trend filter (default: 50)

  // Entry: RSI range for pullback within uptrend
  buyRsiMin: number; // RSI lower bound (default: 45)
  buyRsiMax: number; // RSI upper bound (default: 55)

  // Exit conditions
  exitRsiThreshold: number; // Not used in Option A — reserved, keep at 0
  stopLossPct: number; // Hard stop % below entry (default: 5)
  maxHoldDays: number; // Time-based exit in trading days (default: 20)
}

export const DEFAULT_SIGNAL_THRESHOLDS: SignalThresholds = {
  smaPeriod: 50,
  buyRsiMin: 45,
  buyRsiMax: 55,
  exitRsiThreshold: 0,
  stopLossPct: 5,
  maxHoldDays: 20,
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
}
