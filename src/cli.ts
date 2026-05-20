#!/usr/bin/env node
/**
 * Cue — unified CLI (Market Pulse–style routing).
 */

import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";
import Database from "better-sqlite3";

import { getConfig } from "./config/index.js";
import { migrateTracked } from "./db/migrator.js";
import { initSchema } from "./db/schema.js";
import { resolveDbPath } from "./db/provider.js";

const program = new Command();

program
  .name("cue")
  .description("Cue — US equity signal pipeline")
  .version("0.1.0");

program
  .command("db:migrate")
  .description("apply tracked SQLite migrations (idempotent)")
  .action(() => {
    const config = getConfig();
    const resolved = resolveDbPath(config.DB_PATH);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const db = new Database(resolved);
    db.pragma("foreign_keys = ON");
    initSchema(db);
    const result = migrateTracked(db);
    db.close();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("ingest")
  .description("fetch daily OHLCV (Massive)")
  .allowUnknownOption(true)
  .action(async () => {
    const { runFetcher } = await import("./ingestors/massive-price-ingestor.js");
    await runFetcher();
  });

program
  .command("screen")
  .description("live momentum screen (or --ticker X for signal probe)")
  .allowUnknownOption(true)
  .action(async () => {
    const { runScreenCli } = await import("./analysers/momentum-screener.js");
    runScreenCli();
  });

program
  .command("enrich")
  .description("LLM enrich pending BUY signals")
  .action(async () => {
    const { runEnrichCli } = await import("./agents/thesis-generator.js");
    await runEnrichCli();
  });

program
  .command("brief:dashboard")
  .description("write dist/dashboard.html")
  .allowUnknownOption(true)
  .action(async () => {
    const { runBriefDashboardCli } = await import("./briefing/dashboard.js");
    runBriefDashboardCli(process.argv);
  });

program
  .command("brief:alert")
  .description("send Telegram alerts for enriched BUYs (requires --mode)")
  .allowUnknownOption(true)
  .action(async () => {
    const { runBriefAlertCli } = await import("./briefing/telegram-dispatcher.js");
    await runBriefAlertCli(process.argv);
  });

program
  .command("brief")
  .description("run brief:dashboard then brief:alert (same argv forwarded)")
  .allowUnknownOption(true)
  .action(async () => {
    const { runBriefDashboardCli } = await import("./briefing/dashboard.js");
    const { runBriefAlertCli } = await import("./briefing/telegram-dispatcher.js");
    runBriefDashboardCli(process.argv);
    await runBriefAlertCli(process.argv);
  });

program
  .command("pipeline")
  .description("orchestrated pipeline (use --now for one-shot)")
  .allowUnknownOption(true)
  .action(async () => {
    const { runDailyWorkflowCli } = await import("./agents/daily-workflow.js");
    runDailyWorkflowCli();
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
