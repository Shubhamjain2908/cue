import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import { initSchema } from "../db/schema.js";
import { momentum5d, rsi14, sma, volumeRatio } from "./indicators.js";
import type { SignalDecision, SignalMetrics, SignalThresholds } from "./types.js";
import { DEFAULT_SIGNAL_THRESHOLDS } from "./types.js";

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

export function decideSide(
  closes: number[],
  volumes: number[],
  qqqCloses: readonly number[],
  thresholds: SignalThresholds,
  positionOpen: boolean,
  buyGateFirstFail?: BuyGateFirstFailCounters,
): "BUY" | "SELL" | "HOLD" {
  // Regime filter — first gate in entry path
  // EXIT path is unaffected: open positions can still be exited in bear regime
  if (!positionOpen) {
    const qqqSma200 = sma(200, [...qqqCloses]);
    if (
      qqqSma200 === null ||
      qqqCloses[qqqCloses.length - 1]! <= qqqSma200
    ) {
      return "HOLD";
    }
  }

  if (closes.length < 200) {
    return "HOLD";
  }

  const today = closes[closes.length - 1]!;
  const sma50 = sma(thresholds.smaPeriod, closes);
  const sma200 = sma(200, closes);
  const rsiToday = rsi14(closes);
  const rsiYest = rsi14(closes.slice(0, -1));
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
      volRatio === null
    ) {
      buyGateFirstFail.skippedNullIndicators += 1;
    } else if (today <= sma200) {
      buyGateFirstFail.failedSma200 += 1;
    } else if (today <= sma50) {
      buyGateFirstFail.failedSma50 += 1;
    } else if (rsiToday > thresholds.buyRsiMax) {
      buyGateFirstFail.failedRsiCeiling += 1;
    } else if (rsiToday <= rsiYest) {
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
    volRatio === null
  ) {
    return "HOLD";
  }

  if (positionOpen) {
    const takeProfit = rsiToday >= thresholds.exitRsiThreshold;
    if (takeProfit) {
      return "SELL";
    }
  }

  if (!positionOpen) {
    const aboveSma200 = today > sma200;
    const aboveSma50 = today > sma50;
    const inPullback = rsiToday <= thresholds.buyRsiMax;
    const rsiTurning = rsiToday > rsiYest;
    const volumeOk = volRatio >= thresholds.buyVolumeRatio;
    if (
      aboveSma200 &&
      aboveSma50 &&
      inPullback &&
      rsiTurning &&
      volumeOk
    ) {
      return "BUY";
    }
  }

  return "HOLD";
}

function signalThresholdsFromConfig(): SignalThresholds {
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
 * Pure signal engine: exhaustion entry (trend + RSI turn + volume) and
 * RSI take-profit exit when `positionOpen` is true. Runner applies gap/stop
 * and max-hold at execution.
 */
export function generateSignal(input: GenerateSignalInput): SignalDecision {
  const thresholds = input.thresholds ?? DEFAULT_SIGNAL_THRESHOLDS;
  const metrics = computeSignalMetrics({
    close: input.close,
    volume: input.volume,
  });
  const positionOpen = input.positionOpen ?? false;
  const signal = decideSide(
    [...input.close],
    [...input.volume],
    input.qqqCloses,
    thresholds,
    positionOpen,
    input.buyGateFirstFail,
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
        `SELECT date, close, volume FROM daily_prices WHERE ticker = ? ORDER BY date ASC`,
      )
      .all(ticker) as Array<{ date: string; close: number; volume: number }>;
    if (rows.length === 0) {
      console.log("HOLD");
      process.exit(0);
    }
    const lastDate = rows[rows.length - 1]!.date;
    const qqqRows = db
      .prepare(
        `SELECT close FROM daily_prices WHERE ticker = 'QQQ' AND date <= ? ORDER BY date ASC`,
      )
      .all(lastDate) as Array<{ close: number }>;
    if (qqqRows.length === 0) {
      console.error("QQQ not found in daily_prices — required for regime filter");
      process.exit(1);
    }
    const { signal } = generateSignal({
      close: rows.map((r) => r.close),
      volume: rows.map((r) => r.volume),
      qqqCloses: qqqRows.map((r) => r.close),
      thresholds: signalThresholdsFromConfig(),
      positionOpen: false,
    });
    console.log(signal === "BUY" ? "BUY" : "HOLD");
  } finally {
    db.close();
  }
}