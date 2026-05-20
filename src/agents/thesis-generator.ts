import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfig } from "../config/index.js";
import { listUnenrichedBuySignals } from "../db/queries.js";
import { openCueDb } from "../db/provider.js";
import { runEnrichment } from "../llm/enricher.js";

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

async function main(): Promise<void> {
  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  try {
    const pending = listUnenrichedBuySignals(db);
    if (pending.length === 0) {
      console.log("No unenriched BUY signals.");
      return;
    }
    for (const s of pending) {
      try {
        const r = await runEnrichment(db, s.id);
        console.log(`Enriched ${s.ticker} (${s.id}): ${r.sentiment} / ${r.confidence}`);
      } catch (e) {
        console.error(`Enrichment failed for ${s.ticker} (${s.id}):`, e);
      }
    }
  } finally {
    db.close();
  }
}

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
