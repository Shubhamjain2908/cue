#!/usr/bin/env tsx
/**
 * One-shot backfill: replay corporate_actions splits against daily_prices.
 *
 * Idempotency: pipeline_state key `backfill_split_applied:{ticker}:{ex_date}`.
 * Splits are applied in ex_date ascending order (oldest first).
 *
 * Usage:
 *   npx tsx scripts/backfill_historical_split_adjustments.ts
 *   -- or --
 *   pnpm run cue -- backfill-splits
 */

import { pathToFileURL } from "node:url";

import type winston from "winston";

import { createCueLogger } from "../src/cli/cue-logger.js";

import { getConfig } from "../src/config/index.js";
import { getPipelineState, setPipelineState } from "../src/db/queries.js";
import { openCueDb, type CueDatabase } from "../src/db/provider.js";
import {
  adjustDailyPricesBeforeExDate,
  splitDailyPricesPipelineKey,
} from "../src/ingestors/corporate-actions.js";

type CorporateActionRow = {
  ticker: string;
  ex_date: string;
  factor: number;
};

export type BackfillSplitAdjustFn = (
  db: CueDatabase,
  params: { ticker: string; exDate: string; factor: number },
) => number;

export function runBackfillHistoricalSplitAdjustments(
  db: CueDatabase,
  logger: winston.Logger,
  deps: { adjustDailyPrices?: BackfillSplitAdjustFn } = {},
): { applied: number; skipped: number; failed: number } {
  const adjustDailyPrices = deps.adjustDailyPrices ?? adjustDailyPricesBeforeExDate;
  const rows = db
    .prepare(
      `
      SELECT ticker, ex_date, factor
      FROM corporate_actions
      ORDER BY ex_date ASC
    `,
    )
    .all() as CorporateActionRow[];

  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const key = splitDailyPricesPipelineKey(row.ticker, row.ex_date);
    if (getPipelineState(db, key) === "1") {
      logger.info(
        `backfill skip ${row.ticker} ex_date=${row.ex_date} (pipeline_state already set)`,
      );
      skipped += 1;
      continue;
    }

    try {
      db.transaction(() => {
        const changes = adjustDailyPrices(db, {
          ticker: row.ticker,
          exDate: row.ex_date,
          factor: row.factor,
        });
        setPipelineState(db, key, "1");
        logger.info(
          `backfill applied ${row.ticker} ex_date=${row.ex_date} factor=${row.factor} rows=${changes}`,
        );
      })();
      applied += 1;
    } catch (err: unknown) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`backfill failed ${row.ticker} ex_date=${row.ex_date}: ${msg}`);
    }
  }

  logger.info(`backfill complete: ${applied} applied, ${skipped} skipped, ${failed} failed`);
  return { applied, skipped, failed };
}

function main(): void {
  let db: CueDatabase;
  try {
    const config = getConfig();
    db = openCueDb(config.DB_PATH);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`backfill: cannot open database: ${msg}\n`);
    process.exit(1);
  }

  const logger = createCueLogger("backfill");

  try {
    const result = runBackfillHistoricalSplitAdjustments(db, logger);
    process.exit(result.failed > 0 ? 1 : 0);
  } finally {
    db.close();
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main();
}
