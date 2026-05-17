import fs from "node:fs";
import path from "node:path";

import {
  cachedOhlcvBundleSchema,
  type CachedOhlcvBundle,
} from "./types.js";

/** Polygon OHLCV file cache TTL (Section 4.2). */
export const OHLCV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function resolveCacheRoot(cacheDir: string): string {
  return path.isAbsolute(cacheDir)
    ? cacheDir
    : path.resolve(process.cwd(), cacheDir);
}

function sanitizeTickerForFilename(ticker: string): string {
  return ticker.toUpperCase().replace(/[^A-Z0-9.-]/g, "");
}

export function ohlcvCacheFilePath(
  cacheDir: string,
  ticker: string,
  rangeStart: string,
  rangeEnd: string,
): string {
  const root = resolveCacheRoot(cacheDir);
  const safe = sanitizeTickerForFilename(ticker);
  return path.join(root, `${safe}_${rangeStart}_${rangeEnd}.json`);
}

function isFresh(mtimeMs: number, ttlMs: number): boolean {
  return Date.now() - mtimeMs < ttlMs;
}

/**
 * Returns parsed bundle if a cache file exists, is younger than `ttlMs`,
 * and validates; otherwise `null` (caller may hit the API).
 */
export function readCachedOhlcvIfFresh(
  cacheDir: string,
  ticker: string,
  rangeStart: string,
  rangeEnd: string,
  ttlMs: number = OHLCV_CACHE_TTL_MS,
): CachedOhlcvBundle | null {
  const filePath = ohlcvCacheFilePath(cacheDir, ticker, rangeStart, rangeEnd);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!isFresh(stat.mtimeMs, ttlMs)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const result = cachedOhlcvBundleSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  const bundle = result.data;
  if (
    bundle.ticker.toUpperCase() !== ticker.toUpperCase() ||
    bundle.rangeStart !== rangeStart ||
    bundle.rangeEnd !== rangeEnd
  ) {
    return null;
  }
  return bundle;
}

/** Writes the bundle to disk, creating `cacheDir` if needed. */
export function writeCachedOhlcv(
  cacheDir: string,
  bundle: CachedOhlcvBundle,
): void {
  const validated = cachedOhlcvBundleSchema.parse(bundle);
  const root = resolveCacheRoot(cacheDir);
  fs.mkdirSync(root, { recursive: true });
  const filePath = ohlcvCacheFilePath(
    cacheDir,
    validated.ticker,
    validated.rangeStart,
    validated.rangeEnd,
  );
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(validated, null, 0)}\n`,
    "utf8",
  );
}
