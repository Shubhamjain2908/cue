export type TradeSignal = "BUY" | "SELL" | "HOLD";

export interface SignalThresholds {
  /** BUY when RSI is strictly above this value (momentum confirmation; default 60). */
  buyRsiMin: number;
  /** BUY when 5d momentum % is strictly above this value (default 3). */
  buyMomentumMinPct: number;
  /** BUY when volume ratio is strictly above this value (default 1.3). */
  buyVolumeRatioMin: number;
  /** SELL when RSI is strictly below this value (momentum fading; default 45). */
  exitRsiMax: number;
  /** SELL when price is down more than this percent from entry (spec default 5). */
  stopLossPct: number;
}

export const DEFAULT_SIGNAL_THRESHOLDS: SignalThresholds = {
  buyRsiMin: 60,
  buyMomentumMinPct: 3,
  buyVolumeRatioMin: 1.3,
  exitRsiMax: 45,
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
