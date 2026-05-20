# Market Pulse — CLI routing and DB migration pattern

This document isolates the **unified CLI entry** (`src/cli.ts`, [Commander](https://github.com/tj/commander.js)) and the **SQLite migration runner** (`src/db/migrate.ts`). There is no `src/db/migrator.ts` in this repository; migration logic lives in **`migrate.ts`**.

---

## 1. `package.json` scripts that invoke the CLI

These are the **`scripts`** entries that run `src/cli.ts` (via `tsx`) or the built binary. Other scripts (typecheck, tests, one-off `.mts` tools) are omitted here.

```json
{
  "main": "dist/cli.js",
  "bin": { "mp": "./dist/cli.js" },
  "scripts": {
    "dev": "tsx watch src/cli.ts",
    "start": "node dist/cli.js",
    "cli": "tsx src/cli.ts",
    "migrate": "tsx src/cli.ts migrate",
    "regime:signals": "tsx src/cli.ts regime-signals",
    "regime": "tsx src/cli.ts regime",
    "regime:classify": "tsx src/cli.ts regime:classify",
    "regime:gate-summary": "tsx src/cli.ts regime:gate-summary",
    "momentum:rank": "tsx src/cli.ts momentum-rank",
    "momentum:rebalance": "tsx src/cli.ts momentum-rebalance",
    "ingest": "tsx src/cli.ts ingest",
    "enrich": "tsx src/cli.ts enrich",
    "screen": "tsx src/cli.ts screen",
    "brief": "tsx src/cli.ts brief",
    "evaluate": "tsx src/cli.ts evaluate",
    "run-all": "tsx src/cli.ts run-all",
    "daily": "tsx src/cli.ts daily",
    "kite-login": "tsx src/cli.ts kite-login",
    "kite-verify": "tsx src/cli.ts kite-verify",
    "scan": "tsx src/cli.ts scan",
    "schedule": "tsx src/cli.ts schedule"
  }
}
```

| `pnpm` script | argv passed to CLI |
|---------------|-------------------|
| `cli` | *(passthrough)* e.g. `pnpm cli ingest -d 2025-01-01` |
| `migrate` | `migrate` |
| `regime:signals` | `regime-signals` |
| `regime` | `regime` |
| `regime:classify` | `regime:classify` |
| `regime:gate-summary` | `regime:gate-summary` |
| `momentum:rank` | `momentum-rank` |
| `momentum:rebalance` | `momentum-rebalance` |
| `ingest` | `ingest` |
| `enrich` | `enrich` |
| `screen` | `screen` |
| `brief` | `brief` |
| `evaluate` | `evaluate` |
| `run-all` | `run-all` |
| `daily` | `daily` |
| `kite-login` | `kite-login` |
| `kite-verify` | `kite-verify` |
| `scan` | `scan` |
| `schedule` | `schedule` |

**Not wired through `src/cli.ts`:** `regime:seed-gates`, `momentum:backfill-universe`, `momentum:refresh-earnings`, `kite-auth`, `healthcheck`, `llm:smoke:*` (separate script files).

---

## 2. CLI routing — behavior summary

| Mechanism | Role |
|-----------|------|
| **Commander** `Command` | Single program `mp`; subcommands map 1:1 to pipeline stages or tools. |
| **Global options** | `-d, --date <YYYY-MM-DD>` and `--no-color` on the root program; subactions read `program.opts().date` after parse. |
| **`ensureDb()`** | Opens DB via `getDb()`, then calls **`migrate()`** so schema is current before most commands (cheap/idempotent). |
| **`closeDb()`** | Releases SQLite connection after each command (or on scheduler signals). |
| **`main()`** | `program.parseAsync(process.argv)` inside `try/catch`; sets `process.exitCode = 1` on failure. |

**Commands that skip `ensureDb()`:** `migrate` (only runs `migrate()` + `closeDb()`), `kite-login`, `kite-verify` (client only until success path), `doctor`, `llm-smoke`.

---

## 3. Structural `src/cli.ts` (routing skeleton)

Below is the **same routing surface** as the real file: imports are summarized; **`.action` bodies that only orchestrate** are kept short; **multi-step pipeline / verbose logging** is collapsed to `// …` comments.

```typescript
#!/usr/bin/env node
/**
 * Market Pulse AI - CLI entry point.
 * Subcommands map 1:1 to pipeline stages (see repo for full banner).
 */

import { Command } from 'commander';
import { z } from 'zod';
// Agents / stages: backtester, briefing-composer, daily-ingestor, daily-workflow,
// live-scanner, portfolio-*, regime-agent, signal-enricher, stock-screener, thesis-generator
// Analysers: regime-classifier
// Briefing: deliverBriefing
// Config: config, constants APP_NAME / APP_VERSION
// DB: closeDb, countGatesForRegime, getDb, getRegimeForCalendarDate, listAllowedGatesForRegime, migrate
// Enrichers: computeRegimeSignals, enrichSentiment
// Dates: isoDateIst, optionalCliIsoDate
// Kite: runKiteLogin, KiteApiError, KiteClient
// LLM: getLlmProvider
// Logger: logger
// Market: defaultIngestSymbolUniverse, getIngestAllEquitySymbolsUnion, getMarketClosure, syncSymbolSectorsFromYahoo
// Rankers / scheduler / strategies / scripts: momentum-ranker, market-scheduler, momentum-rebalance, evaluate-trades

const program = new Command();

program
  .name('mp')
  .description(`${APP_NAME} - personal Indian-markets briefing pipeline`)
  .version(APP_VERSION)
  .option('-d, --date <YYYY-MM-DD>', 'target trading date (defaults to today, IST)')
  .option('--no-color', 'disable coloured output');

program
  .command('migrate')
  .description('apply database migrations (idempotent)')
  .action(async () => {
    const result = migrate();
    logger.info({ ...result }, 'migrations done');
    closeDb();
  });

program
  .command('regime-signals')
  .description('print regime signal inputs + weighted scores for validation (Phase 1)')
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const signals = computeRegimeSignals(getDb(), date);
    console.log(JSON.stringify(signals, null, 2));
    closeDb();
  });

program
  .command('regime:gate-summary')
  .description('print allowed strategies + size multipliers for the regime on the given date (default today)')
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    // … load regime row; list gates; JSON.stringify; set exitCode on missing row …
    closeDb();
  });

program
  .command('regime:classify')
  .description('deterministic regime only → regime_daily (narrative null; for backfill)')
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = runRegimeClassifier({ date });
    logger.info(/* summary fields */, 'regime classified (deterministic)');
    console.log(JSON.stringify(result, null, 2));
    closeDb();
  });

program
  .command('regime')
  .description('full regime agent: classify + LLM narrative (or templated fallback) → regime_daily')
  .option('--no-narrative', 'skip LLM; persist templated fallback narrative only')
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const skipLlm = process.argv.includes('--no-narrative');
    const result = await runRegimeAgent({ date, skipLlm });
    logger.info(/* regime / changed / fallback */, 'regime agent complete');
    console.log(JSON.stringify(result, null, 2));
    closeDb();
  });

program
  .command('ingest')
  .description('stage 1: pull market data from configured sources')
  .option('-s, --symbols <list>', 'comma-separated symbols, or `all` for union universe')
  .action(async (opts: { symbols?: string }) => {
    ensureDb();
    // … parse opts.symbols → string[] | undefined (special-case `all`) …
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runDailyIngestor({ date, symbols });
    logger.info(result, 'ingest complete');
    closeDb();
  });

program
  .command('sync-sectors')
  .description('fetch Yahoo Finance sector/industry for symbols missing rows in `symbols`')
  .option('-s, --symbols <list>', 'comma-separated symbols (default: full ingest universe)')
  .option('--force', 'refresh sector even when already cached')
  .action(async (opts: { symbols?: string; force?: boolean }) => {
    ensureDb();
    // … resolve universe from opts or defaultIngestSymbolUniverse(getDb()) …
    const result = await syncSymbolSectorsFromYahoo(universe, getDb(), { force: Boolean(opts.force) });
    logger.info(result, 'sync-sectors complete');
    closeDb();
  });

program
  .command('enrich')
  .description('stage 2: technical indicators + momentum factors (universe) + blackout')
  .option('-s, --symbols <list>', 'comma-separated list of symbols')
  .action(async (opts: { symbols?: string }) => {
    ensureDb();
    const symbols = /* split/trim opts.symbols */;
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runSignalEnricher({ date, symbols });
    logger.info(result, 'enrich complete');
    closeDb();
  });

program
  .command('momentum-rank')
  .description('phase 4.1: momentum composite z-score rank + false-flag (writes signals)')
  .option('-s, --symbols <list>', 'comma-separated universe override (default: momentum-universe.json)')
  .action(async (opts: { symbols?: string }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const universe = /* parse optional symbols */;
    const result = runMomentumRanker({ asOf: date, universe: universe?.length ? universe : undefined });
    logger.info(result, 'momentum-rank complete');
    closeDb();
  });

program
  .command('momentum-rebalance')
  .description('phase 4.2: regime gate → liquidate / rank exits / entries')
  .option('-s, --symbols <list>', 'comma-separated universe override for embedded ranker')
  .option('--skip-ranker', 'use existing mom_rank signals for session (no ranker pass)')
  .option('--skip-thesis', 'skip LLM entry thesis')
  .option('--brief', 'compose skip-AI briefing with rebalance summary and deliver')
  .action(async (opts: { symbols?: string; skipRanker?: boolean; brief?: boolean; skipThesis?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const universe = /* parse optional symbols */;
    const result = await runMomentumRebalance({
      calendarDate: date,
      universe: universe?.length ? universe : undefined,
      skipRanker: Boolean(opts.skipRanker),
      skipThesis: Boolean(opts.skipThesis),
    });
    logger.info(result, 'momentum-rebalance complete');
    // if (opts.brief) { … runBriefingComposer + deliverBriefing … }
    closeDb();
  });

program
  .command('screen')
  .description("stage 3: run screens + alert scan against today's signals")
  .option('-n, --screen <name>', 'restrict to a single screen by name')
  .action(async (opts: { screen?: string }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runStockScreener({ date, screen: opts.screen });
    logger.info(result, 'screen complete');
    closeDb();
  });

program
  .command('backtest')
  .description('replay screens against historical EOD data and persist results')
  .requiredOption('-s, --start <YYYY-MM-DD>', 'inclusive start date of replay window')
  .requiredOption('-e, --end <YYYY-MM-DD>', 'inclusive end date of replay window')
  .option('-h, --hold-days <n>', 'trading sessions to hold each match', '10')
  .option('-n, --screen <name>', 'restrict to a single screen by name')
  .action(async (opts: { start: string; end: string; holdDays: string; screen?: string }) => {
    ensureDb();
    const summary = await runBacktester({
      startDate: opts.start,
      endDate: opts.end,
      holdDays: Number(opts.holdDays) || 10,
      screenName: opts.screen,
    });
    // … per-result logging …
    closeDb();
  });

program
  .command('sentiment')
  .description('score unscored news headlines using the LLM provider')
  .option('-l, --limit <number>', 'max headlines to process', '100')
  .action(async (opts: { limit?: string }) => {
    ensureDb();
    const result = await enrichSentiment({ limit: Number(opts.limit) || 100 });
    logger.info(result, 'sentiment scoring complete');
    closeDb();
  });

program
  .command('thesis')
  .description('generate AI theses for top-signal watchlist stocks')
  .option('-n, --max <number>', 'max theses to generate', '5')
  .action(async (opts: { max?: string }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await generateTheses({ date, maxTheses: Number(opts.max) || 5 });
    logger.info({ generated: result.generated, failed: result.failed }, 'thesis generation complete');
    closeDb();
  });

program
  .command('brief')
  .description('stage 4: compose + deliver the daily briefing')
  .option('--delivery <method>', "override delivery method ('file' | 'email' | 'slack' | 'telegram')")
  .option('--skip-ai', 'skip LLM narrative generation in the briefing')
  .action(async (opts: { delivery?: 'file' | 'email' | 'slack' | 'telegram'; skipAi?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runBriefingComposer({ date, delivery: opts.delivery, skipAi: opts.skipAi });
    await deliverBriefing(result.html, result.date, opts.delivery ?? config.BRIEFING_DELIVERY);
    closeDb();
  });

program
  .command('evaluate')
  .description('evaluate open paper trades against EOD quotes (SL / target / time-stop)')
  .option('--skip-ai', 'skip LLM post-mortem narratives for STOPPED_OUT rows')
  .action(async (opts: { skipAi?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const result = runEvaluatePaperTrades(date, getDb(), { skipAi: Boolean(opts.skipAi) });
    logger.info(result, 'paper trade evaluation complete');
    closeDb();
  });

program
  .command('run-all')
  .description('run full pipeline: ingest -> enrich -> regime -> gated screen -> sentiment -> thesis -> brief')
  .option('--skip-ai', 'skip all LLM stages (sentiment, thesis, narrative)')
  .action(async (opts: { skipAi?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    // … if market closed: runBriefingComposer + deliverBriefing + closeDb + return …
    // … else: runDailyIngestor → runSignalEnricher → runRegimeAgent → runStockScreener →
    //    optional sentiment + generateTheses → runBriefingComposer → deliverBriefing …
    closeDb();
  });

program
  .command('daily')
  .description('one-shot: full pipeline + portfolio sync + per-holding LLM analysis')
  .option('--skip-ai', 'skip all LLM stages (sentiment, thesis, portfolio analysis)')
  .option('--skip-portfolio', 'skip portfolio sync + analysis (rest of pipeline runs)')
  .action(async (opts: { skipAi?: boolean; skipPortfolio?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runDailyWorkflow({ date, skipAi: opts.skipAi, skipPortfolio: opts.skipPortfolio });
    await deliverBriefing(result.html, result.date, config.BRIEFING_DELIVERY);
    logger.info(/* counts, holidayMode, … */, 'daily run complete');
    closeDb();
  });

program
  .command('kite-login')
  .description('refresh Zerodha Kite Connect access_token (interactive)')
  .action(async () => {
    const result = await runKiteLogin();
    logger.info({ user: result.userId, name: result.userName, envPath: result.envPath }, 'kite access_token saved to .env');
  });

program
  .command('kite-verify')
  .description('GET portfolio/holdings — verify API key + access_token')
  .action(async () => {
    const client = new KiteClient();
    // … session check; try/catch KiteApiError; set process.exitCode …
  });

program
  .command('portfolio-sync')
  .description('sync holdings from Kite (or config/portfolio.json) into the DB')
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runPortfolioSync({ date });
    logger.info(result, 'portfolio sync done');
    closeDb();
  });

program
  .command('portfolio-analyse')
  .description('run LLM-driven HOLD/ADD/TRIM/EXIT analysis on each holding')
  .option('-s, --symbols <list>', 'comma-separated subset of holdings to analyse')
  .option('--min-position <inr>', 'skip holdings below this rupee value', '0')
  .option('-j, --concurrency <n>', 'parallel LLM calls (default: PORTFOLIO_ANALYSIS_CONCURRENCY from env)')
  .action(async (opts: { symbols?: string; minPosition?: string; concurrency?: string }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await analysePortfolio({
      date,
      symbols: /* split opts.symbols */,
      minPositionInr: Number(opts.minPosition) || 0,
      concurrency: opts.concurrency ? Number(opts.concurrency) : undefined,
    });
    logger.info({ analysed: result.analysed, failed: result.failed, byAction: result.byAction }, 'portfolio analysis done');
    closeDb();
  });

program
  .command('scan')
  .description('one-shot intraday LTP refresh via Kite (cron every 5-15 min)')
  .option('-t, --threshold <pct>', 'pct move that triggers a live alert', '3')
  .action(async (opts: { threshold?: string }) => {
    ensureDb();
    const result = await runLiveScan({ alertThresholdPct: Number(opts.threshold) || 3 });
    logger.info(result, 'live scan done');
    closeDb();
  });

program
  .command('schedule')
  .description('start croner schedule (08:45 / 16:30 weekdays, Sat 08:00 IST)')
  .option('--run-now', 'run one cycle immediately on startup')
  .action(async (opts: { runNow?: boolean }) => {
    ensureDb();
    // if (opts.runNow) { await runDailyWorkflow(); await deliverBriefing(...); closeDb(); }
    const handle = startScheduler();
    process.on('SIGINT', () => { handle.stop(); closeDb(); process.exit(0); });
    process.on('SIGTERM', () => { handle.stop(); closeDb(); process.exit(0); });
    await new Promise<void>(() => { /* never resolves; SIGINT/SIGTERM exit */ });
  });

program
  .command('llm-smoke')
  .description('quick live LLM text + JSON smoke check for active provider')
  .action(async () => {
    const provider = getLlmProvider();
    // … generateText + generateJson with zod schema; console.log …
  });

program
  .command('doctor')
  .description('print runtime + config diagnostics (no secrets)')
  .action(async () => {
    const summary = { app: /* … */, runtime: /* … */, pipeline: /* … */, secrets: /* redacted flags */ };
    console.log(JSON.stringify(summary, null, 2));
  });

function redact(value: string | undefined): 'set' | 'missing' {
  return value && value.length > 0 ? 'set' : 'missing';
}

function ensureDb(): void {
  getDb();
  migrate();
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    logger.error({ err }, 'cli command failed');
    process.exitCode = 1;
  }
}

void main();
```

**Colocated patterns in the real file (not duplicated above):**

- **Colon subcommands:** `regime:classify`, `regime:gate-summary` — plain Commander `.command('…')` strings; invoked as `mp regime:classify`.
- **Boolean flags:** Commander supplies `skipAi`, `skipRanker`, etc.; some code also checks `process.argv.includes('--no-narrative')` for `regime`.
- **Global date:** Subcommands use `optionalCliIsoDate(program.opts().date)` so `-d` applies after `program.parse`.

---

## 4. Migration runner — `src/db/migrate.ts` (full)

Re-exported from `src/db/index.ts` as `migrate` / `MigrateResult`. **`_migrations`** is the ledger table; **`schema.sql`** is synthetic migration id **`0001_base_schema`**; numbered files under **`migrations/*.sql`** run in **lexicographic filename order** after the base schema.

```typescript
/**
 * Migration runner. Loads SQL files from `src/db/migrations/` (sorted by
 * filename) and applies any that haven't been recorded in `_migrations`.
 * The base `schema.sql` is treated as migration #0001 and runs on first init.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DatabaseType } from 'better-sqlite3';
import { logger } from '../logger.js';
import { getDb } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface MigrationRecord {
  id: string;
  applied_at: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export function migrate(db: DatabaseType = getDb()): MigrateResult {
  ensureMigrationsTable(db);

  const applied = new Set(
    db
      .prepare('SELECT id FROM _migrations ORDER BY id')
      .all()
      .map((r) => (r as MigrationRecord).id),
  );

  const result: MigrateResult = { applied: [], skipped: [] };

  const baseSchema = '0001_base_schema';
  if (!applied.has(baseSchema)) {
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, datetime('now'))").run(
      baseSchema,
    );
    result.applied.push(baseSchema);
    logger.info({ migration: baseSchema }, 'applied base schema');
  } else {
    result.skipped.push(baseSchema);
  }

  const migrationsDir = join(__dirname, 'migrations');
  let migrationFiles: string[] = [];
  try {
    migrationFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    // No migrations dir yet - that's fine in Phase 0.
  }

  for (const file of migrationFiles) {
    const id = file.replace(/\.sql$/, '');
    if (applied.has(id)) {
      result.skipped.push(id);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
    result.applied.push(id);
    logger.info({ migration: id }, 'applied migration');
  }

  return result;
}

function ensureMigrationsTable(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}
```

**Execution order (sequential, idempotent):**

1. `CREATE TABLE IF NOT EXISTS _migrations …`
2. Load applied ids from `_migrations`.
3. If `0001_base_schema` missing → `exec(schema.sql)` → `INSERT` that id.
4. For each `migrations/*.sql` sorted by name → if id not in set → `exec(file)` → `INSERT` id.
5. Return `{ applied, skipped }` for logging.

**Cue porting notes:** Keep the same **filename-sort = apply order** convention; reserve a dedicated **base** id before numeric migrations; use a single **append-only** migrations directory.

---

*For line-accurate CLI bodies, see `src/cli.ts` in the repository.*
