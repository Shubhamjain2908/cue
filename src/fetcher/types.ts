import { z } from "zod";

/** One daily bar stored in SQLite `daily_prices` and in the file cache. */
export const dailyOhlcvBarSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().int().nonnegative(),
});

export type DailyOhlcvBar = z.infer<typeof dailyOhlcvBarSchema>;

/** Payload written under `data/cache/` for daily aggregate ranges (Massive REST). */
export const cachedOhlcvBundleSchema = z.object({
  ticker: z.string().min(1),
  rangeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rangeEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bars: z.array(dailyOhlcvBarSchema),
});

export type CachedOhlcvBundle = z.infer<typeof cachedOhlcvBundleSchema>;

/** One aggregate bar from Massive `getStocksAggregates` (fields `o` / `h` / `l` / `c` / `v` / `t`; optional `vw`, `n`, `otc`). */
export const massiveStocksAggResultSchema = z.object({
  v: z.number(),
  vw: z.number().optional(),
  o: z.number(),
  c: z.number(),
  h: z.number(),
  l: z.number(),
  t: z.number(),
  n: z.number().optional(),
  otc: z.boolean().optional(),
});

export type MassiveStocksAggResult = z.infer<typeof massiveStocksAggResultSchema>;

/**
 * Envelope for Massive `GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}` JSON.
 * When `next_url` is set, the fetcher loads further pages with axios (see `src/fetcher/index.ts`).
 */
export const massiveStocksAggregatesResponseSchema = z
  .object({
    ticker: z.string().optional(),
    status: z.string().optional(),
    adjusted: z.boolean().optional(),
    queryCount: z.number().optional(),
    resultsCount: z.number().optional(),
    count: z.number().optional(),
    request_id: z.string().optional(),
    results: z.array(massiveStocksAggResultSchema).optional(),
    next_url: z.string().optional(),
  })
  .passthrough();

export type MassiveStocksAggregatesResponse = z.infer<
  typeof massiveStocksAggregatesResponseSchema
>;
