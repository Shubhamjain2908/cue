import { getConfig } from "../config/index.js";
import { momentum5d, rsi14, sma, volumeRatio } from "./indicators.js";
import type {
  SignalDecision,
  SignalExitReason,
  SignalMetrics,
  SignalThresholds,
} from "./momentum-types.js";
import { DEFAULT_SIGNAL_THRESHOLDS } from "./momentum-types.js";

/** Mutable counters: first failing BUY gate per bar (mutually exclusive when all indicators non-null). */
export interface BuyGateFirstFailCounters {
  failedSma200: number;
  failedSma50: number;
  failedRsiCeiling: number;
  failedRsiTurn: number;
  failedVolume: number;
  passedAll: number;
  /** Indicators null; excluded from the six-way first-fail partition. */
  skippedNullIndicators: number;
}

export function createBuyGateFirstFailCounters(): BuyGateFirstFailCounters {
  return {
    failedSma200: 0,
    failedSma50: 0,
    failedRsiCeiling: 0,
    failedRsiTurn: 0,
    failedVolume: 0,
    passedAll: 0,
    skippedNullIndicators: 0,
  };
}

export function computeSignalMetrics(input: {
  close: readonly number[];
  volume: readonly number[];
}): SignalMetrics {
  const lastClose =
    input.close.length > 0 ? input.close[input.close.length - 1]! : null;
  return {
    rsi14: rsi14(input.close),
    momentum5dPct: momentum5d(input.close),
    volumeRatio: volumeRatio(input.volume),
    lastClose,
  };
}

export type DecideSideResult =
  | { side: "HOLD" }
  | { side: "BUY" }
  | { side: "SELL"; reason: SignalExitReason };

export function decideSide(
  closes: number[],
  volumes: number[],
  qqqCloses: readonly number[],
  thresholds: SignalThresholds,
  positionOpen: boolean,
  buyGateFirstFail?: BuyGateFirstFailCounters,
): DecideSideResult {
  // Regime filter — first gate in entry path
  // EXIT path is unaffected: open positions can still be exited in bear regime
  if (!positionOpen) {
    const qqqSma200 = sma(200, [...qqqCloses]);
    if (
      qqqSma200 === null ||
      qqqCloses[qqqCloses.length - 1]! <= qqqSma200
    ) {
      return { side: "HOLD" };
    }
  }

  if (closes.length < 200) {
    return { side: "HOLD" };
  }

  const today = closes[closes.length - 1]!;
  const sma50 = sma(thresholds.smaPeriod, closes);
  const sma200 = sma(200, closes);
  const rsiToday = rsi14(closes);
  const rsiYest = rsi14(closes.slice(0, -1));
  const rsi2DaysAgo = rsi14(closes.slice(0, -2));
  const volRatio = volumeRatio(volumes);

  if (
    buyGateFirstFail !== undefined &&
    !positionOpen
  ) {
    if (
      sma50 === null ||
      sma200 === null ||
      rsiToday === null ||
      rsiYest === null ||
      rsi2DaysAgo === null ||
      volRatio === null
    ) {
      buyGateFirstFail.skippedNullIndicators += 1;
    } else if (today <= sma200) {
      buyGateFirstFail.failedSma200 += 1;
    } else if (today <= sma50) {
      buyGateFirstFail.failedSma50 += 1;
    } else if (rsiToday > thresholds.buyRsiMax) {
      buyGateFirstFail.failedRsiCeiling += 1;
    } else if (!(rsiToday > rsiYest && rsiYest > rsi2DaysAgo)) {
      buyGateFirstFail.failedRsiTurn += 1;
    } else if (volRatio < thresholds.buyVolumeRatio) {
      buyGateFirstFail.failedVolume += 1;
    } else {
      buyGateFirstFail.passedAll += 1;
    }
  }

  if (
    sma50 === null ||
    sma200 === null ||
    rsiToday === null ||
    rsiYest === null ||
    rsi2DaysAgo === null ||
    volRatio === null
  ) {
    return { side: "HOLD" };
  }

  if (positionOpen) {
    const takeProfit = rsiToday >= thresholds.exitRsiThreshold;
    const trendBreak = today < sma50;
    if (takeProfit) {
      return { side: "SELL", reason: "TAKE_PROFIT" };
    }
    if (trendBreak) {
      return { side: "SELL", reason: "TREND_BREAK" };
    }
  }

  if (!positionOpen) {
    const aboveSma200 = today > sma200;
    const aboveSma50 = today > sma50;
    const inPullback = rsiToday <= thresholds.buyRsiMax;
    const rsiTurning = rsiToday > rsiYest && rsiYest > rsi2DaysAgo;
    const volumeOk = volRatio >= thresholds.buyVolumeRatio;
    if (
      aboveSma200 &&
      aboveSma50 &&
      inPullback &&
      rsiTurning &&
      volumeOk
    ) {
      return { side: "BUY" };
    }
  }

  return { side: "HOLD" };
}

export function buildSignalThresholdsFromConfig(): SignalThresholds {
  const c = getConfig();
  return {
    smaPeriod: c.smaPeriod,
    buyRsiMax: c.buyRsiMax,
    buyVolumeRatio: c.buyVolumeRatio,
    exitRsiThreshold: c.exitRsiThreshold,
    stopLossPct: c.stopLossPct,
    maxHoldDays: c.maxHoldDays,
  };
}

export interface GenerateSignalInput {
  close: readonly number[];
  volume: readonly number[];
  qqqCloses: readonly number[];
  thresholds?: SignalThresholds;
  positionOpen?: boolean;
  buyGateFirstFail?: BuyGateFirstFailCounters;
}

/**
 * Pure signal engine: exhaustion entry (trend + two-day RSI turn + volume) and
 * RSI take-profit or short-SMA trend-break exit when `positionOpen` is true.
 * Runner applies gap/stop and max-hold at execution.
 */
export function generateSignal(input: GenerateSignalInput): SignalDecision {
  const thresholds = input.thresholds ?? DEFAULT_SIGNAL_THRESHOLDS;
  const metrics = computeSignalMetrics({
    close: input.close,
    volume: input.volume,
  });
  const positionOpen = input.positionOpen ?? false;
  const result = decideSide(
    [...input.close],
    [...input.volume],
    input.qqqCloses,
    thresholds,
    positionOpen,
    input.buyGateFirstFail,
  );
  const reason = result.side === "SELL" ? result.reason : undefined;
  return { signal: result.side, reason, metrics };
}
