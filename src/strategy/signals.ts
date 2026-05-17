import path from "node:path";
import { fileURLToPath } from "node:url";

import { momentum5d, rsi14, volumeRatio } from "./indicators.js";
import type {
  OpenPositionContext,
  SignalDecision,
  SignalMetrics,
  SignalThresholds,
  TradeSignal,
} from "./types.js";
import { DEFAULT_SIGNAL_THRESHOLDS } from "./types.js";

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

function decideSide(
  metrics: SignalMetrics,
  thresholds: SignalThresholds,
  position: OpenPositionContext | undefined,
): TradeSignal {
  const { rsi14: rsi, momentum5dPct: mom, volumeRatio: vol, lastClose } = metrics;

  if (position !== undefined && lastClose !== null) {
    if (rsi !== null && rsi < thresholds.exitRsiMax) {
      return "SELL";
    }
    const stopReturnPct =
      ((lastClose - position.entryPrice) / position.entryPrice) * 100;
    if (stopReturnPct < -thresholds.stopLossPct) {
      return "SELL";
    }
    return "HOLD";
  }

  const buyOk =
    rsi !== null &&
    rsi > thresholds.buyRsiMin &&
    mom !== null &&
    mom > thresholds.buyMomentumMinPct &&
    vol !== null &&
    vol > thresholds.buyVolumeRatioMin;

  return buyOk ? "BUY" : "HOLD";
}

/**
 * Pure signal engine: maps OHLCV arrays to BUY | SELL | HOLD (momentum breakout entry,
 * RSI fade + stop exit). Pass thresholds explicitly — no env reads.
 */
export function generateSignal(input: {
  close: readonly number[];
  volume: readonly number[];
  thresholds?: SignalThresholds;
  position?: OpenPositionContext;
}): SignalDecision {
  const thresholds = input.thresholds ?? DEFAULT_SIGNAL_THRESHOLDS;
  const metrics = computeSignalMetrics({
    close: input.close,
    volume: input.volume,
  });
  return {
    signal: decideSide(metrics, thresholds, input.position),
    metrics,
  };
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

if (isMain) {
  // Phase 1 stops before live screening; `pnpm run screen` is wired for later phases.
  console.error(
    "screen is not implemented in Phase 1 (fetcher + DB-backed screener come later).",
  );
  process.exit(1);
}
