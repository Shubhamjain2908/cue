import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import { initSchema } from "../db/schema.js";
import { momentum5d, rsi14, sma, volumeRatio } from "./indicators.js";
import type {
  OpenPositionContext,
  SignalDecision,
  SignalMetrics,
  SignalThresholds,
  TradeSignal,
} from "./types.js";
import { DEFAULT_SIGNAL_THRESHOLDS } from "./types.js";

/** Long-horizon trend filter (hard gate for BUY); not configurable in v1 Option A+SMA200. */
const SMA_LONG_FILTER_PERIOD = 200;

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

export function decideSide(
  closes: number[],
  volumes: number[],
  thresholds: SignalThresholds,
): TradeSignal {
  void volumes;
  const smaVal = sma(thresholds.smaPeriod, closes);
  const currentRsi = rsi14(closes);
  const today = closes[closes.length - 1]!;

  if (smaVal === null || currentRsi === null) {
    return "HOLD";
  }

  const smaLong = sma(SMA_LONG_FILTER_PERIOD, closes);
  if (smaLong === null || today <= smaLong) {
    return "HOLD";
  }

  const trendAboveSma = today > smaVal;
  const rsiInRange =
    currentRsi >= thresholds.buyRsiMin && currentRsi <= thresholds.buyRsiMax;

  if (trendAboveSma && rsiInRange) {
    return "BUY";
  }

  return "HOLD";
}

function signalThresholdsFromConfig(): SignalThresholds {
  const c = getConfig();
  return {
    smaPeriod: c.smaPeriod,
    buyRsiMin: c.buyRsiMin,
    buyRsiMax: c.buyRsiMax,
    exitRsiThreshold: c.exitRsiThreshold,
    stopLossPct: c.stopLossPct,
    maxHoldDays: c.maxHoldDays,
  };
}

/**
 * Pure signal engine: maps OHLCV arrays to BUY | SELL | HOLD (Option A: trend +
 * pullback entry, with SMA200 long-trend hard filter). Exits from this layer are
 * not used in Option A — the backtest runner applies stop-loss and max-hold.
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

  if (input.position !== undefined) {
    return { signal: "HOLD", metrics };
  }

  const signal = decideSide(
    [...input.close],
    [...input.volume],
    thresholds,
  );
  return { signal, metrics };
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

if (isMain) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--ticker");
  const raw = idx >= 0 ? argv[idx + 1] : undefined;
  if (!raw) {
    console.error("Usage: pnpm run screen -- --ticker SYMBOL");
    process.exit(1);
  }
  const ticker = raw.toUpperCase();
  const config = getConfig();
  const db = new Database(config.DB_PATH);
  try {
    initSchema(db);
    const rows = db
      .prepare(
        `SELECT close, volume FROM daily_prices WHERE ticker = ? ORDER BY date ASC`,
      )
      .all(ticker) as Array<{ close: number; volume: number }>;
    if (rows.length === 0) {
      console.log("HOLD");
      process.exit(0);
    }
    const { signal } = generateSignal({
      close: rows.map((r) => r.close),
      volume: rows.map((r) => r.volume),
      thresholds: signalThresholdsFromConfig(),
    });
    console.log(signal === "BUY" ? "BUY" : "HOLD");
  } finally {
    db.close();
  }
}
