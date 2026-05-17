export type TradeSignal = "BUY" | "SELL" | "HOLD";

export interface SignalThresholds {
  /** BUY when RSI is strictly below this value (spec default 35). */
  buyRsiMax: number;
  /** BUY when 5d momentum % is strictly below this value (spec default -8). */
  buyMomentumMaxPct: number;
  /** BUY when volume ratio is strictly above this value (spec default 1.5). */
  buyVolumeRatioMin: number;
  /** SELL when RSI is strictly above this value (spec default 60). */
  exitRsiMin: number;
  /** SELL when price is down more than this percent from entry (spec default 5). */
  stopLossPct: number;
}

export const DEFAULT_SIGNAL_THRESHOLDS: SignalThresholds = {
  buyRsiMax: 35,
  buyMomentumMaxPct: -8,
  buyVolumeRatioMin: 1.5,
  exitRsiMin: 60,
  stopLossPct: 5,
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
