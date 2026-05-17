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

/** Payload written under `data/cache/` for Polygon daily aggregate ranges. */
export const cachedOhlcvBundleSchema = z.object({
  ticker: z.string().min(1),
  rangeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rangeEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bars: z.array(dailyOhlcvBarSchema),
});

export type CachedOhlcvBundle = z.infer<typeof cachedOhlcvBundleSchema>;

/** Single result object from Polygon `v2/aggs/ticker/.../range/1/day/...`. */
export const polygonAggResultSchema = z.object({
  v: z.number(),
  vw: z.number().optional(),
  o: z.number(),
  c: z.number(),
  h: z.number(),
  l: z.number(),
  t: z.number(),
  n: z.number().optional(),
});

export type PolygonAggResult = z.infer<typeof polygonAggResultSchema>;

/** Top-level Polygon aggregates response (fields vary; unknown keys are ignored). */
export const polygonAggsResponseSchema = z
  .object({
    ticker: z.string().optional(),
    status: z.string().optional(),
    adjusted: z.boolean().optional(),
    queryCount: z.number().optional(),
    resultsCount: z.number().optional(),
    results: z.array(polygonAggResultSchema).optional(),
  })
  .passthrough();

export type PolygonAggsResponse = z.infer<typeof polygonAggsResponseSchema>;
