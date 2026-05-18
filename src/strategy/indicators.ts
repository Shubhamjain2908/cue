/**
 * RSI(14) via Wilder's smoothed averaging (Cue spec §6.4).
 * Requires at least 28 adjusted closes (14 seed + 14 warm-up bars).
 */
export function rsi14(closes: readonly number[]): number | null {
  if (closes.length < 28) {
    return null;
  }

  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i]! - closes[i - 1]!);
  }

  let sumGain = 0;
  let sumLoss = 0;
  for (let i = 0; i < 14; i++) {
    const d = deltas[i]!;
    if (d > 0) {
      sumGain += d;
    } else if (d < 0) {
      sumLoss += -d;
    }
  }

  let avgGain = sumGain / 14;
  let avgLoss = sumLoss / 14;

  for (let i = 14; i < deltas.length; i++) {
    const d = deltas[i]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * 13 + gain) / 14;
    avgLoss = (avgLoss * 13 + loss) / 14;
  }

  if (avgGain === 0 && avgLoss === 0) {
    return 50;
  }
  if (avgLoss === 0) {
    return 100;
  }
  if (avgGain === 0) {
    return 0;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Simple Moving Average over the last `period` values of `closes`.
 * Returns null if closes.length < period (insufficient data).
 */
export function sma(period: number, closes: number[]): number | null {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  return window.reduce((sum, v) => sum + v, 0) / period;
}

/**
 * 5-day momentum % on adjusted close (Cue spec §6.4).
 * Uses the most recent close vs the close 5 trading days earlier.
 */
export function momentum5d(closes: readonly number[]): number | null {
  if (closes.length < 6) {
    return null;
  }
  const last = closes[closes.length - 1]!;
  const base = closes[closes.length - 6]!;
  if (base === 0) {
    return null;
  }
  return ((last - base) / base) * 100;
}

const MIN_AVG_VOLUME_20D = 50_000;

/**
 * 20d average volume / 60d average volume on the trailing window (Cue spec §6.4).
 * Returns null when history is insufficient, 60d average is zero, or the 50k share guard fails.
 */
export function volumeRatio(volumes: readonly number[]): number | null {
  if (volumes.length < 60) {
    return null;
  }
  const last20 = volumes.slice(-20);
  const last60 = volumes.slice(-60);
  const avg20 = last20.reduce((acc, v) => acc + v, 0) / 20;
  const avg60 = last60.reduce((acc, v) => acc + v, 0) / 60;
  if (avg20 < MIN_AVG_VOLUME_20D || avg60 === 0) {
    return null;
  }
  return avg20 / avg60;
}

/**
 * ATR — Wilder's Smoothed Average True Range (per §6.4)
 * Requires parallel arrays: highs[i], lows[i], closes[i], all same length.
 * Returns null if insufficient data (< period + 1 bars).
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14,
): number | null {
  const n = closes.length;
  if (n < period + 1) {
    return null;
  }

  // True Range series
  const tr: number[] = [];
  for (let i = 1; i < n; i++) {
    tr.push(
      Math.max(
        highs[i]! - lows[i]!,
        Math.abs(highs[i]! - closes[i - 1]!),
        Math.abs(lows[i]! - closes[i - 1]!),
      ),
    );
  }

  // Seed: simple average of first `period` TR values
  let atrVal = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Wilder smoothing for remaining bars
  for (let i = period; i < tr.length; i++) {
    atrVal = (atrVal * (period - 1) + tr[i]!) / period;
  }

  return atrVal;
}
