import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfig } from "../config/index.js";
import { listUnenrichedBuySignals, listUnenrichedWatchlistSignals } from "../db/queries.js";
import { openCueDb } from "../db/provider.js";
import { runEnrichment } from "../llm/enricher.js";

export async function runEnrichCli(): Promise<void> {
  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  try {
    const pending = listUnenrichedBuySignals(db);
    if (pending.length === 0) {
      console.log("No unenriched BUY signals.");
    }
    const buyResults = await Promise.allSettled(
      pending.map((s) => runEnrichment(db, s.id)),
    );
    for (let i = 0; i < buyResults.length; i++) {
      const s = pending[i]!;
      const result = buyResults[i]!;
      if (result.status === "fulfilled") {
        const r = result.value;
        console.log(`Enriched ${s.ticker} (${s.id}): ${r.sentiment} / ${r.confidence}`);
      } else {
        console.error(`Enrichment failed for ${s.ticker} (${s.id}):`, result.reason);
      }
    }

    const watchlistPending = listUnenrichedWatchlistSignals(db);
    if (watchlistPending.length === 0) {
      console.log("No unenriched WATCHLIST signals.");
    }
    const watchlistResults = await Promise.allSettled(
      watchlistPending.map((s) => runEnrichment(db, s.id)),
    );
    for (let i = 0; i < watchlistResults.length; i++) {
      const s = watchlistPending[i]!;
      const result = watchlistResults[i]!;
      if (result.status === "fulfilled") {
        const r = result.value;
        console.log(`Enriched watchlist ${s.ticker} (${s.id}): ${r.sentiment} / ${r.confidence}`);
      } else {
        console.warn(`Watchlist enrichment failed for ${s.ticker} (${s.id}):`, result.reason);
      }
    }
  } finally {
    db.close();
  }
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

if (isMain) {
  runEnrichCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
