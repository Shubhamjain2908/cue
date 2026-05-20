import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { getConfig } from "../config/index.js";

/** On-disk shape of `data/universe/<UNIVERSE>.json` (read fresh each call; no cache). */
export const universeTickersFileSchema = z.object({
  tickers: z.array(z.string().min(1)),
});

export type UniverseTickersFile = z.infer<typeof universeTickersFileSchema>;

/** Operational metadata: `data/universe/_meta.json`. */
export const universeMetaSchema = z
  .object({
    universe_name: z.string().min(1),
    as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    total_ticker_count: z.number().int().positive(),
    system_additions: z.array(z.string().min(1)),
    index_company_count: z.number().int().positive().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

export type UniverseMeta = z.infer<typeof universeMetaSchema>;

export function resolveUniverseJsonPath(projectRoot: string, universeKey: string): string {
  return path.join(projectRoot, "data", "universe", `${universeKey}.json`);
}

export function resolveUniverseMetaPath(projectRoot: string): string {
  return path.join(projectRoot, "data", "universe", "_meta.json");
}

/**
 * Loads `data/universe/${UNIVERSE}.json` from disk every time (no module-level cache).
 * Tickers are uppercased; duplicate symbols after normalization throw.
 */
export function loadUniverseTickers(projectRoot: string = process.cwd()): string[] {
  const { UNIVERSE } = getConfig();
  const filePath = resolveUniverseJsonPath(projectRoot, UNIVERSE);
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = universeTickersFileSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    throw new Error(`Invalid universe file ${filePath}: ${parsed.error.message}`);
  }
  const upper = parsed.data.tickers.map((t) => t.toUpperCase());
  const seen = new Set<string>();
  for (const t of upper) {
    if (seen.has(t)) {
      throw new Error(`Universe file ${filePath} contains duplicate ticker: ${t}`);
    }
    seen.add(t);
  }
  return upper;
}

/** Returns parsed `_meta.json`, or `null` if the file is absent. Throws if present but invalid. */
export function tryLoadUniverseMeta(projectRoot: string = process.cwd()): UniverseMeta | null {
  const p = resolveUniverseMetaPath(projectRoot);
  if (!fs.existsSync(p)) {
    return null;
  }
  const raw = fs.readFileSync(p, "utf8");
  const parsed = universeMetaSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    throw new Error(`Invalid universe metadata ${p}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** True when `_meta.json` declares the same count as the loaded ticker list. */
export function universeMetaMatchesTickerCount(
  meta: UniverseMeta,
  actualTickerCount: number,
): boolean {
  return meta.total_ticker_count === actualTickerCount;
}
