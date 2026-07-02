#!/usr/bin/env node
/**
 * Cue — unified CLI (Market Pulse–style granular subcommands).
 */

import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";
import Database from "better-sqlite3";

import { getConfig } from "./config/index.js";
import { CUE_TIME_ZONE } from "./config/cue-timezone.js";
import { cueLogger } from "./cli/cue-logger.js";
import { runDoctorCli } from "./cli/doctor.js";
import { initSchema } from "./db/schema.js";
import { resolveDbPath } from "./db/provider.js";

/**
 * Arguments for Commander after `node <script>` (see `parseAsync` with `from: 'node'`).
 *
 * With `pnpm run cue -- ingest …`, `process.argv` is often:
 * `[node, tsx, …/src/cli.ts, '--', 'ingest', '--flags', …]`.
 * Commander treats `--` as "end of options" and bundles `ingest` + flags into operands, so
 * subcommand `.opts()` (e.g. `--date`) stay empty. Strip the entry file and a leading `--`.
 */
function cueUserArgsAfterEntry(argv: string[]): string[] {
  const rest = argv.slice(2);
  let i = 0;
  while (i < rest.length) {
    const a = rest[i]!;
    if (a === "--") {
      i += 1;
      continue;
    }
    const base = path.basename(a);
    if (base === "cli.ts" || base === "cli.tsx") {
      i += 1;
      continue;
    }
    break;
  }
  return rest.slice(i);
}

function wrap(subcommand: string, fn: () => void | Promise<void>): () => void | Promise<void> {
  return async () => {
    try {
      cueLogger.info(`subcommand_start subcommand=${subcommand}`);
      await fn();
      cueLogger.info(`subcommand_done subcommand=${subcommand}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      cueLogger.error(`subcommand_failed subcommand=${subcommand} error=${msg}`, {
        stack: err instanceof Error ? err.stack : undefined,
      });
      process.exitCode = 1;
    }
  };
}

const program = new Command();

program
  .name("cue")
  .description("Cue — US equity signal pipeline (granular subcommands)")
  .version("0.1.0")
  .configureHelp({ sortSubcommands: true })
  .addHelpText(
    "before",
    `
Subcommands (run \`pnpm run cue --help\` or \`pnpm run cue <name> --help\` for flags):
  db:migrate           Apply SQLite migrations (src/db/migrations/*.sql + _migrations ledger)
  ingest               Nasdaq 100 (+ QQQ) EOD OHLCV via Massive
  adjust-splits        Adjust open position price levels for recent stock splits (Yahoo)
  enrich-fundamentals  Phase 4: Yahoo Finance context → disk cache (placeholder for fundamentals_cache)
  backfill-prices      Deep grouped-daily OHLCV backfill for universe ranking gaps
  screen               Momentum screen / technical ranking (or --ticker probe)
  enrich               LLM sentiment + thesis for pending BUY and WATCHLIST signals
  quality-snapshot     Phase 1: compute Financial Health Score for BUY tickers (reads Yahoo payload, persists quality block)
  refresh-thesis       Daily position thesis refresh (P7-F; gated on 15+ genuine closed trades)
  llm-smoke            Live LLM check: text + JSON + mini thesis (active provider)
  brief                Static HTML dashboard + Telegram alerts
  execute-stops        Stop-day path: trailing stops, high-water, stop-outs (no rebalance BUYs)
  restamp-entry-fills  Restamp open positions' entry price from signal close to next-bar open
  run-all              Run full pipeline once (subprocess chain, same as scheduled window)
  schedule             Scheduler daemon (Tue–Sat 06:00–06:10 ET stop; Sun rebalance 06:00–06:10 ET)
  healthcheck          Post-pipeline verification + Telegram alert (after morning window)
  doctor               Config + DB + env presence diagnostics
  pipeline             Legacy alias: \`--now\` = one-shot run-all; no flag = same as schedule
`,
  );

program
  .command("db:migrate")
  .description("Run SQLite migrations (numbered .sql under src/db/migrations/)")
  .action(
    wrap("db:migrate", () => {
      const config = getConfig();
      const resolved = resolveDbPath(config.DB_PATH);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const db = new Database(resolved);
      db.pragma("foreign_keys = ON");
      try {
        const result = initSchema(db);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        db.close();
      }
    }),
  );

const ingest = program
  .command("ingest")
  .description("Ingest Nasdaq 100 EOD OHLCV via Massive (Massive.com / Polygon key)")
  .option("--ticker <symbol>", "fetch a single ticker only")
  .option(
    "--date <ymd>",
    "calendar date for grouped daily bars (YYYY-MM-DD); default: latest ET weekday on or before now",
  )
  .option("--force", "refetch latest session even if daily_prices already has that session", false);

ingest.action(
  wrap("ingest", async () => {
    const o = ingest.opts<{ ticker?: string; force: boolean; date?: string }>();
    const argv = ["node", "cue", "ingest"];
    if (o.ticker !== undefined && o.ticker.length > 0) {
      argv.push("--ticker", o.ticker.toUpperCase());
    }
    if (o.date !== undefined && o.date.length > 0) {
      argv.push("--date", o.date);
    }
    if (o.force) {
      argv.push("--force");
    }
    const { runFetcher } = await import("./ingestors/massive-price-ingestor.js");
    await runFetcher(argv);
  }),
);

program
  .command("adjust-splits")
  .description("Adjust open position and signal price levels for recent stock splits (Yahoo Finance)")
  .action(
    wrap("adjust-splits", async () => {
      const config = getConfig();
      const { openCueDb } = await import("./db/provider.js");
      const { adjustSplitsForOpenPositions } = await import("./ingestors/corporate-actions.js");
      const db = openCueDb(config.DB_PATH);
      try {
        await adjustSplitsForOpenPositions(db, undefined, cueLogger);
      } finally {
        db.close();
      }
    }),
  );

program
  .command("backfill-splits")
  .description("One-shot: replay corporate_actions splits against historical daily_prices")
  .action(
    wrap("backfill-splits", async () => {
      const { runBackfillHistoricalSplitAdjustments } = await import(
        "../scripts/backfill_historical_split_adjustments.js"
      );
      const config = getConfig();
      const { openCueDb } = await import("./db/provider.js");
      const db = openCueDb(config.DB_PATH);
      try {
        const result = runBackfillHistoricalSplitAdjustments(db, cueLogger);
        if (result.failed > 0) {
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    }),
  );

const enrichFundamentals = program
  .command("enrich-fundamentals")
  .description("Phase 4: Yahoo Finance fundamentals context (cache on disk; DB table TBD)")
  .option("--ticker <symbol>", "fetch Yahoo bundles for one ticker")
  .option("--limit <n>", "when no --ticker: how many universe names (default 3)", "3")
  .option("--force", "when no --ticker: fetch entire universe (slow)", false)
  .option("--date <ymd>", "reserved: as-of date filter (not implemented)", undefined);

enrichFundamentals.action(
  wrap("enrich-fundamentals", async () => {
    const o = enrichFundamentals.opts<{ ticker?: string; limit: string; force: boolean; date?: string }>();
    const { runEnrichFundamentalsCli } = await import("./ingestors/enrich-fundamentals-cli.js");
    const limit = Number.parseInt(o.limit, 10);
    await runEnrichFundamentalsCli({
      ticker: o.ticker,
      force: o.force,
      date: o.date,
      limit: Number.isFinite(limit) ? limit : 3,
    });
  }),
);

const backfillPrices = program
  .command("backfill-prices")
  .description("Deep grouped-daily OHLCV backfill for universe + QQQ (fills <252-bar gaps)")
  .option("--from <ymd>", "start date YYYY-MM-DD (default: 600 calendar days before --to)")
  .option("--to <ymd>", "end date YYYY-MM-DD (default: latest QQQ date in DB)")
  .option("--min-bars <n>", "coverage report threshold (default 252)", "252");

backfillPrices.action(
  wrap("backfill-prices", async () => {
    const o = backfillPrices.opts<{ from?: string; to?: string; minBars: string }>();
    const { runHistoricalPriceBackfill } = await import("./ingestors/massive-price-ingestor.js");
    const minBars = Number.parseInt(o.minBars, 10);
    await runHistoricalPriceBackfill({
      from: o.from,
      to: o.to,
      minBars: Number.isFinite(minBars) ? minBars : 252,
    });
  }),
);

const screen = program
  .command("screen")
  .description("Momentum screener: live ranking / exits (or --ticker for BUY/HOLD probe)")
  .option("--ticker <symbol>", "print BUY/HOLD for one ticker")
  .option(
    "--date <ymd>",
    "as-of session date YYYY-MM-DD (default: latest QQQ date in daily_prices)",
  )
  .option("--force-rebalance", "treat as rebalance Friday-style screen", false);

screen.action(
  wrap("screen", async () => {
    const o = screen.opts<{ ticker?: string; forceRebalance: boolean; date?: string }>();
    const tail: string[] = [];
    if (o.ticker !== undefined && o.ticker.length > 0) {
      tail.push("--ticker", o.ticker.toUpperCase());
    }
    if (o.date !== undefined && o.date.length > 0) {
      tail.push("--date", o.date);
    }
    if (o.forceRebalance) {
      tail.push("--force-rebalance");
    }
    const { runScreenCli } = await import("./analysers/momentum-screener.js");
    runScreenCli(tail);
  }),
);

const qualitySnapshot = program
  .command("quality-snapshot")
  .description("Financial Health Score for BUY tickers (reads Yahoo payload from fundamentals_cache, persists quality block)")
  .option("--ticker <symbol>", "repeatable: snapshot specific tickers (default: today's unalerted BUY signals)")
  .allowUnknownOption(true);

qualitySnapshot.action(
  wrap("quality-snapshot", async () => {
    const argv = process.argv;
    const idx = argv.indexOf("quality-snapshot");
    const rest = idx >= 0 ? argv.slice(idx + 1) : [];
    const tickers: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--ticker" && i + 1 < rest.length) {
        tickers.push(rest[i + 1]!.toUpperCase());
        i++;
      }
    }
    const { runQualitySnapshotCli } = await import("./analysers/quality-snapshot-cli.js");
    await runQualitySnapshotCli({ tickers: tickers.length > 0 ? tickers : undefined });
  }),
);

program
  .command("enrich")
  .description("LLM enrich pending BUY and WATCHLIST signals (thesis-generator)")
  .action(
    wrap("enrich", async () => {
      const { runEnrichCli } = await import("./agents/thesis-generator.js");
      await runEnrichCli();
    }),
  );

program
  .command("refresh-thesis")
  .description("Daily position thesis refresh (P7-F; requires 15+ genuine closed trades)")
  .action(
    wrap("refresh-thesis", async () => {
      const { runRefreshCli } = await import("./agents/thesis-generator.js");
      await runRefreshCli();
    }),
  );

program
  .command("llm-smoke")
  .description("Live LLM smoke test: short text, JSON (zod), mini thesis JSON (uses LLM_PROVIDER + keys from .env)")
  .action(
    wrap("llm-smoke", async () => {
      const { runLlmSmokeCli } = await import("./cli/llm-smoke.js");
      await runLlmSmokeCli();
    }),
  );

const brief = program
  .command("brief")
  .description("Build dist/dashboard.html and send Telegram alerts (BUY + watchlist bench on rebalance)")
  .option("--mode <mode>", "Telegram branch: rebalance | stop", "stop")
  .option("--skip-dashboard", "only Telegram", false)
  .option("--skip-alert", "only dashboard HTML", false)
  .option("--open", "open dashboard in browser after write", false);

brief.action(
  wrap("brief", async () => {
    const o = brief.opts<{ mode: string; skipDashboard: boolean; skipAlert: boolean; open: boolean }>();
    const argv = ["node", "cue", "brief", "--mode", o.mode];
    if (o.open) {
      argv.push("--open");
    }
    if (!o.skipDashboard) {
      const { runBriefDashboardCli } = await import("./briefing/dashboard.js");
      runBriefDashboardCli(argv);
    }
    if (!o.skipAlert) {
      const { runBriefAlertCli } = await import("./briefing/telegram-dispatcher.js");
      await runBriefAlertCli(argv);
    }
  }),
);

const briefDashboard = program
  .command("brief:dashboard")
  .description("Write dist/dashboard.html only (for scripts / CI)")
  .option("--open", "open browser after write", false)
  .allowUnknownOption(true);

briefDashboard.action(
  wrap("brief:dashboard", async () => {
    const o = briefDashboard.opts<{ open: boolean }>();
    const argv = ["node", "cue", "brief:dashboard", ...(o.open ? ["--open"] : [])];
    const { runBriefDashboardCli } = await import("./briefing/dashboard.js");
    runBriefDashboardCli(argv);
  }),
);

program
  .command("brief:alert")
  .description("(internal) Telegram alerts only (requires --mode)")
  .allowUnknownOption(true)
  .action(
    wrap("brief:alert", async () => {
      const { runBriefAlertCli } = await import("./briefing/telegram-dispatcher.js");
      await runBriefAlertCli(process.argv);
    }),
  );

const executeStops = program
  .command("execute-stops")
  .description("Evaluate trailing stops / max-hold for OPEN positions (stop-day path only)")
  .option("--dry-run", "reserved: no DB writes", false)
  .option(
    "--date <ymd>",
    "as-of session date YYYY-MM-DD (default: latest QQQ date in daily_prices)",
  );

executeStops.action(
  wrap("execute-stops", async () => {
    const o = executeStops.opts<{ dryRun: boolean; date?: string }>();
    const tail: string[] = [];
    if (o.date !== undefined && o.date.length > 0) {
      tail.push("--date", o.date);
    }
    const { runExecuteStopsCli } = await import("./analysers/momentum-screener.js");
    runExecuteStopsCli(tail);
  }),
);

program
  .command("restamp-entry-fills")
  .description("Restamp open positions' entry price from signal close to earliest next-bar open")
  .action(
    wrap("restamp-entry-fills", async () => {
      const { runRestampEntryCli } = await import("./analysers/restamp-entry-fills.js");
      await runRestampEntryCli();
    }),
  );

program
  .command("run-all")
  .description("Run full pipeline once (ingest → screen → enrich? → brief) via subprocesses")
  .allowUnknownOption(true)
  .action(
    wrap("run-all", async () => {
      const { runAllPipelineCli } = await import("./agents/daily-workflow.js");
      const code = runAllPipelineCli(process.argv);
      process.exit(code);
    }),
  );

program
  .command("schedule")
  .description(
    `Start scheduler daemon (${CUE_TIME_ZONE}; Sun 06:00–06:10 rebalance, Tue–Sat 06:00–06:10 stops)`,
  )
  .action(
    wrap("schedule", async () => {
      const { runScheduleDaemonCli } = await import("./agents/scheduler.js");
      runScheduleDaemonCli();
    }),
  );

program
  .command("healthcheck")
  .description("Verify ingest, pipeline output, and PM2 logs; alert via Telegram (post morning window)")
  .action(
    wrap("healthcheck", async () => {
      const config = getConfig();
      const { openCueDb } = await import("./db/provider.js");
      const { runHealthcheck } = await import("./agents/healthcheck.js");
      const db = openCueDb(config.DB_PATH);
      try {
        const code = await runHealthcheck(db, config, cueLogger);
        if (code !== 0) {
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    }),
  );

program
  .command("doctor")
  .description("Diagnostics: config, DB file probe, env key presence (no secrets printed)")
  .action(wrap("doctor", () => runDoctorCli()));

program
  .command("pipeline")
  .description("Legacy: use `cue schedule` or `cue run-all`; --now runs registry pipeline once and exits")
  .allowUnknownOption(true)
  .action(
    wrap("pipeline", async () => {
      if (process.argv.includes("--now")) {
        const { runDailyWorkflowCli } = await import("./agents/daily-workflow.js");
        runDailyWorkflowCli();
      } else {
        const { runScheduleDaemonCli } = await import("./agents/scheduler.js");
        runScheduleDaemonCli();
      }
    }),
  );

async function main(): Promise<void> {
  const userArgs = cueUserArgsAfterEntry(process.argv);
  await program.parseAsync(["node", "cue", ...userArgs], { from: "node" });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  cueLogger.error(`cli_fatal error=${msg}`, { stack: err instanceof Error ? err.stack : undefined });
  process.exitCode = 1;
});
