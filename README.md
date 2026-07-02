# Cue

A **personal US-equity signal and briefing pipeline** for the **Nasdaq 100** (plus QQQ as regime context). It ingests end-of-day prices, ranks momentum, applies a QQQ regime gate and ATR-style trailing stops, optionally enriches new BUY candidates with an LLM, and delivers a **static HTML dashboard** plus **Telegram** alerts.

**Not an auto-trader** — Cue does not place orders. You review signals and execute trades yourself (for example via a broker app). The system is built as **small, testable TypeScript modules** plus a **SQLite** ledger so you can re-run any stage in isolation.

> **Status:** Core engine, LLM enrichment, dashboard, Telegram, and **unattended scheduler** are in place (**Phase 9b complete**). EOD data comes from **Massive.com** (Polygon-compatible key in env). Scheduling and all “market day” logic use **`America/New_York`** civil time with locale **`en-US`** (see `src/config/cue-timezone.ts`). **Phase 1 quality score** is shipped as an **advisory-only** overlay (no BUY suppression). **Phase 3 quality-floor** work is backtest research (archive), not live gating.

---

## Why this exists

Retail tools often optimize for either raw charts or a black-box screener. Cue sits in the middle: **repeatable rules** (momentum, regime, stops) plus **optional LLM context** (news, sector, earnings proximity) so you get a short, structured view before the US cash session — without paying for a bundled terminal you do not need.

**What it does on a cadence you control:**

- Pulls **EOD OHLCV** for the configured universe and stores it in SQLite.
- **Screens** for BUY/HOLD/SELL style outcomes, maintains **open positions** and **trailing stop** state.
- On **Sunday rebalance** path (uses **Friday** EOD bars): **split adjustment**, batch enrich-fundamentals, full screen with `--force-rebalance`, quality-snapshot (Financial Health Score), LLM enrich, then brief (BUY alerts + quality line + optional **Next in Rank** bench).
- On **Tue–Sat stop** path: price refresh, **split adjustment**, **execute-stops**, then brief (no rebalance-style screen).
- After the **06:00–06:10 ET** pipeline window: optional **`cue healthcheck`** verifies ingest currency, ingest staleness (`pipeline_state.last_ingest_was_stale`), pipeline output, and critical-step exit codes in `pipeline_state`, then Telegram ✅/⚠️.
- Builds **`dist/dashboard.html`** and sends **Telegram** messages according to `--mode` (`rebalance` vs `stop`).

Authoritative architecture, locked strategy parameters, and pipeline details: **`.cursor/rules/cue-sou.md`**. Hard constraints: **`.cursor/rules/cue-guardrails.md`**. Schema: **`.cursor/rules/cue-db-schema.md`**.

---

## Architecture

Stages write to **SQLite** (`better-sqlite3`) so you can debug or backtest without re-hitting vendors.

```mermaid
flowchart LR
  subgraph ManualOrCron["Operator / systemd / PM2"]
    CLI["pnpm run cue …"]
  end
  CLI --> Ingest["ingest\nMassive EOD"]
  Ingest --> Splits["adjust-splits\nYahoo splits →\npositions + daily_prices"]
  Splits --> DB[("SQLite\ndaily_prices, signals,\npositions, corporate_actions")]
  DB --> Screen["screen\nmomentum + regime"]
  Screen --> DB
  DB --> Fund["enrich-fundamentals\nYahoo → cache"]
  Fund --> Disk[("disk cache\nCACHE_DIR")]
  DB --> Qual["quality-snapshot\nFinancial Health Score"]
  Qual --> DB
  DB --> Stops["execute-stops\nTue–Sat scheduler"]
  Stops --> DB
  DB --> LLM["enrich\nLLM + Yahoo context"]
  LLM --> DB
  DB --> Brief["brief\ndashboard + Telegram"]
  Brief --> Out["dist/*.html\nTelegram API"]
  Sched["scheduler.ts\n60s poll, ET window"] -.->|"subprocess chain"| CLI
  HC["healthcheck.ts\n~07:00 ET cron"] -.->|"pipeline_state +\nDB checks"| DB
  HC -.-> Out
```

**Two orchestration paths:**

| Path | Entry | Behaviour |
|------|--------|-----------|
| **Registry pipeline** | `cue run-all`, `cue pipeline --now` | **Sunday** → rebalance chain; **Tue–Sat** → stop chain (`detectRunMode`); **Monday** idle. |
| **Scheduler daemon** | `cue schedule`, `cue pipeline` (no `--now`) | **Sun 06:00–06:10 ET** rebalance; **Tue–Sat 06:00–06:10 ET** stops; **Monday** idle. |
| **Healthcheck** | `cue healthcheck` | Post-window DB checks + Telegram; PM2 **`cue-healthcheck`** on Sun/Tue-Sat. |

**LLM:** `src/llm/factory.ts` resolves **Anthropic**, **OpenAI**, **Google Studio**, **Vertex AI**, or **mock** from `LLM_PROVIDER`. Structured outputs are validated with **Zod** before writing enrichments.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js **22**+, TypeScript **strict**, **ESM** |
| Package manager | **pnpm** 10 (`packageManager` in `package.json`) |
| DB | **SQLite** via `better-sqlite3` (migrations under `src/db/migrations/`) |
| CLI | **commander** (`src/cli.ts`) |
| HTTP | **axios** (Massive, LLM vendor APIs) |
| Validation | **zod** (env, APIs, LLM JSON) |
| Logging | **winston** (`cue-cli`, `pipeline`, `scheduler` services) |
| Tests | **vitest** |

---

## Quickstart

```bash
pnpm install
cp .env.example .env   # fill POLYGON_API_KEY, TELEGRAM_*, LLM keys, etc.

# Create DB parent dir + apply migrations (see package.json shortcuts)
pnpm run db:init       # or: pnpm run db:migrate

pnpm run cue -- doctor    # config + DB probe (no secrets printed)
pnpm test
pnpm run typecheck && pnpm run lint
```

**Verify LLM wiring before a long run:**

```bash
pnpm llm-smoke
# → three steps: plain text, small JSON, mini thesis JSON (timings printed)
```

**One-shot full registry pipeline (subprocess chain):**

```bash
pnpm run-all
# same step set as `cue pipeline --now` / daily-workflow registry
```

**Long-running scheduler (VPS / systemd):**

```bash
pnpm schedule
# 60s polling, fires inside 06:00–06:10 America/New_York on scheduled ET weekdays
```

---

## CLI reference

All commands go through **`pnpm run cue -- <subcommand>`** (or **`pnpm run cue -- --help`**). The repo also defines **pnpm script shortcuts** where helpful.

### Core

| Command | Description |
|---------|-------------|
| `pnpm run cue -- --help` | List subcommands (sorted) |
| `pnpm run cue -- db:migrate` | Apply pending `src/db/migrations/*.sql` (ledger `_migrations`) |
| `pnpm run cue -- doctor` | Diagnostics: config shape, DB file, required env keys (no secret values) |

### Data & screen

| Command | Description |
|---------|-------------|
| `pnpm run cue -- ingest` | Massive grouped daily OHLCV (one REST call) for a session date; universe + QQQ. Options: `--date YYYY-MM-DD` (single-session explicit mode), `--ticker SYM`, `--force`. Default path tries **T+0 ET weekday session** first, then falls back to **T-1** on 0 bars/recoverable fetch failure; holiday payloads with omitted `results` are treated as 0 bars (not schema-fatal). |
| `pnpm run cue -- adjust-splits` | Yahoo split events → `corporate_actions`; adjusts OPEN `positions` / linked `signals` and retroactive `daily_prices` (OHLC ÷ factor, volume × factor) for `date < ex_date`. Idempotent via `corporate_actions` UNIQUE. **Non-critical** pipeline step (Yahoo outage must not block stops). |
| `pnpm run cue -- backfill-splits` | One-shot: replay existing `corporate_actions` rows against `daily_prices` (idempotent via `pipeline_state`; run once when the ledger has historical splits) |
| `pnpm run cue -- backfill-prices` | Deep grouped-daily OHLCV backfill for universe + QQQ over a date range (fills &lt;252-bar ranking gaps). Options: `--from YYYY-MM-DD` (default: 600 calendar days before `--to`), `--to YYYY-MM-DD` (default: latest QQQ date in DB), `--min-bars N` (coverage report threshold, default 252) |
| `pnpm run cue -- enrich-fundamentals` | Yahoo bundles → disk cache + `fundamentals_cache`. Default: 3 uncached tickers/run (walks universe file order, skipping names already cached for today's ET `as_of_date`; when all are cached, step skips API calls). `--force` = full universe in one run; `--limit N` = larger batch; `--ticker SYM` = one name |
| `pnpm run cue -- screen` | Momentum screener / ranking. Ranks eligible tickers only (&lt;252 bars excluded, logged); alerts show `#rank of eligible (universe total)`. `--date YYYY-MM-DD` (default: latest QQQ session in DB), `--ticker`, `--force-rebalance` |
| `pnpm run cue -- quality-snapshot` | Compute Financial Health Score for BUY tickers (reads Yahoo payload from `fundamentals_cache`, writes `payload_json.quality`). `--ticker SYM` (repeatable). |
| `pnpm run cue -- execute-stops` | Trailing stops / max-hold for OPEN positions (stop-day path). `--date YYYY-MM-DD` (default: latest QQQ session); `--dry-run` reserved |

### LLM & brief

| Command | Description |
|---------|-------------|
| `pnpm run cue -- enrich` | LLM enrichment for pending **BUY** and **WATCHLIST** signals (`thesis-generator`) |
| `pnpm run cue -- llm-smoke` | Live smoke: text + JSON + mini thesis (`pnpm llm-smoke`) |
| `pnpm run cue -- brief` | Dashboard HTML + Telegram. Both modes dispatch **SELL alerts first** (🔴 `TRAILING_STOP`, 🔄 `REBALANCE_DROP`, ⏱ `TIME_EXIT`, ✋ `MANUAL`). Rebalance: BUY alerts + **Next in Rank** bench (`WATCHLIST_BENCH_DEPTH`, default 5). Dashboard: **Live Performance** excludes `MANUAL` / `REBALANCE_DROP` and same-day artefacts; backtest reference pins to latest locked **`MOMENTUM`** run (currently id=82, `window_label` shown in UI). Options: `--mode rebalance\|stop`, `--skip-dashboard`, `--skip-alert`, `--open` |
| `pnpm run cue -- brief:dashboard` | Write `dist/dashboard.html` only (`pnpm dashboard`, `pnpm dashboard:open`) |
| `pnpm run cue -- brief:alert` | Telegram only (internal; expects `--mode` in argv) |

### Orchestration

| Command | Description |
|---------|-------------|
| `pnpm run cue -- run-all` | One-shot **registry** pipeline via subprocesses (`pnpm run-all`) |
| `pnpm run cue -- pipeline --now` | Same as `run-all` (explicit one-shot) |
| `pnpm run cue -- pipeline` | **No `--now`:** same daemon as **`pnpm run cue -- schedule`** |
| `pnpm run cue -- schedule` | Scheduler daemon (`pnpm schedule`) |
| `pnpm run cue -- healthcheck` | Post-pipeline checks (`daily_prices`, ingest staleness flag, signals/stops, `pipeline_state` step exits) + Telegram alert |

### Other scripts (`package.json`)

| Script | Maps to |
|--------|---------|
| `pnpm cue` | `tsx src/cli.ts` (pass args after the script name, e.g. `pnpm run cue ingest --date …` or `pnpm run cue -- ingest --date …`) |
| `pnpm db:init` | `tsx src/db/schema.ts` (init + migrate from config) |
| `pnpm db:migrate` | `pnpm run cue -- db:migrate` |
| `pnpm backtest` | `tsx src/backtest/runner.ts` (default momentum). Research: `pnpm run backtest -- --strategy quality-garp` (defaults `2023-01-01`→`2025-12-31`), `pnpm run backtest -- --strategy vix-momentum` (P7-G sweep; defaults `2022-01-01`→`2025-12-31`). Phase 3 quality-floor research archive: `pnpm run backtest -- --quality-floor N` sweeps thresholds with sector-relative Financial Health Scores (research only; not active live gating). Override window with `--from` / `--to` |
| `pnpm ingest` / `pnpm fetch` | `pnpm run cue -- ingest` |
| `pnpm screen` | `pnpm run cue -- screen` |
| `pnpm enrich` | `pnpm run cue -- enrich` |
| `pnpm brief` | `pnpm run cue -- brief` |
| `pnpm pipeline` / `pnpm pipeline:now` | `pnpm run cue -- pipeline` / `pnpm run cue -- pipeline --now` |
| `pnpm rebuild:native` | `pnpm rebuild better-sqlite3` |

---

## Configuration

1. **`.env`** — validated at startup by `src/config/index.ts` (`zod`). See **`.env.example`** for variables.
2. **`DB_PATH`** — default `./db/cue.db`.
3. **`LOCK_PATH`** — cross-process scheduler PID lockfile (default `./db/cue.lock`; cleared when holder PID is dead).
4. **`CACHE_DIR`** — Yahoo / ingest caches (default `./data/cache`).
5. **`LLM_PROVIDER`** — `anthropic` \| `openai` \| `google-studio` \| `vertex` \| `mock` (provider-specific keys required; Vertex needs `VERTEX_PROJECT_ID` + ADC or service account per `google-auth-library` usage in code).

Strategy thresholds (`MAX_POSITIONS`, `WATCHLIST_BENCH_DEPTH`, `STOP_LOSS_PCT`, RSI gates, etc.) are loaded with the same env object; see **`.cursor/rules/cue-sou.md`** for **locked** momentum / ATR / regime rules. Set **`WATCHLIST_BENCH_DEPTH=0`** to disable watchlist rows and the rebalance **Next in Rank** Telegram message.

---

## Timezone

All **calendar day** and **scheduler window** logic for the US equity pipeline uses:

- **`CUE_TIME_ZONE`** = `America/New_York`
- **`CUE_LOCALE`** = `en-US`

Defined in **`src/config/cue-timezone.ts`** and used from ingest date helpers, `daily-workflow.ts`, and CLI copy where relevant.

---

## Deployment notes

- **PM2:** `deploy/ecosystem.config.cjs` defines:
  - **`cue`** — long-lived scheduler (`src/cli.ts pipeline` or **`src/cli.ts schedule`**); logs `logs/pm2-cue.log`.
  - **`cue-healthcheck`** — post-window check (`0 11 * * 0,2,3,4,5,6` UTC ≈ ~07:00 ET on Sun/Tue-Sat). Use **`0 7 * * 0,2,3,4,5,6`** if host clock is **America/New_York** (PM2 7+ rejects `0,2-6` in cron).
- **systemd:** run `cue schedule` (or `cue pipeline`) as a `Type=simple` long-lived service; send `SIGTERM` for clean shutdown (scheduler closes its readonly DB handle). Schedule `cue healthcheck` separately (cron or second unit) if not using PM2 for the healthcheck app.

---

## Repo layout (high level)

```
cue/
  data/
    universe/       `nasdaq100.json` (constituents) + `_meta.json` (as-of, counts, QQQ note)
  src/
    agents/           thesis-generator, daily-workflow (registry), scheduler.ts, healthcheck.ts
    analysers/        momentum-screener (screen, execute-stops CLI),
                      signal-quality (Financial Health Score),
                      quality-snapshot-cli (CLI entry for quality-snapshot)
    briefing/         dashboard HTML, Telegram dispatcher
    cli/              doctor, llm-smoke, shared CLI helpers (`ymd-arg.ts`)
    config/           env (zod), cue-timezone.ts
    db/               migrations/, queries.ts, provider.ts, schema.ts
    enrichers/        momentum types / math used by screener
    ingestors/        Massive price ingest, corporate-actions (splits), enrich-fundamentals CLI
    universe/         shared `load-universe.ts` (tickers + `_meta.json`)
    llm/              provider adapters, enricher, prompt, yahooContext
    backtest/         historical runner (separate tsx entry)
  deploy/             PM2 ecosystem example
  tests/              vitest
```

---

## Development

```bash
pnpm test              # vitest run
pnpm test:watch
pnpm run typecheck     # tsc --noEmit
pnpm run lint          # eslint
```

Conventions: strict TypeScript, ESM **`import`/`export`**, no ORM (prepared SQL in `queries.ts`), env only through **`getConfig()`**.

---

## Financial Health Score: Production vs Research

### Production (Phase 1)

- Live pipeline behavior is **advisory-only** quality scoring (`cue quality-snapshot`): score is surfaced in BUY/bench Telegram copy, dashboard badges, and LLM prompt context.
- Guardrail: **no BUY suppression** from quality score in production.

### Research archive (Phase 3 quality floor)

Phase 3 developed a **sector-relative Financial Health Score** calibration for the Nasdaq 100 and ran a full backtest sweep (2023–2025) to test quality-floor gating.

### Formula (NDX-calibrated)

| Sub-score | Weight | Scoring method |
|-----------|--------|----------------|
| Profitability | 0.30 | ROE sector-relative (2× median = 1.0, at median = 0.7) |
| Cash health | 0.20 | D/E sector-relative (≤0.5× median = 1.0, at median = 0.7) |
| Valuation | 0.25 | P/E/P/S/P/B sector-relative (≤0.67× median = 1.0) |
| Trend confirm | 0.20 | Close above SMA200 = 1.0 |
| Completeness | 0.05 | Fraction of 15 Yahoo fields non-null |

### Sweep Results

| Filter | CAGR | MaxDD | Sharpe | WinRate | Trades |
|--------|:----:|:-----:|:------:|:-------:|:-----:|
| Baseline | **21.82%** | 10.51% | 1.198 | 54.9% | 102 |
| **Q ≥ 1.5** | **22.07%** ✨ | **9.15%** | **1.237** ✨ | 55.7% | 97 |
| Q ≥ 2.0 | 8.64% | 9.15% | 0.456 | 51.4% | 74 |
| Q ≥ 3.0 | 6.63% | 11.07% | 0.303 | 49.2% | 59 |

### Phase 3 verdict

> **⚠️ Caveat (July 2026):** The Phase 3 quality-floor sweep was conducted before the fundamentals data refresh (PR-3). At research time, 12/15 Financial Health Score input fields were 100% null in `fundamentals_cache` (only P/E, ROE, and D/E were consistently populated). Scores were computed on a sparse data diet. Additionally, `loadQualityScoresForBacktest` reads the **latest snapshot** fundamentals and applies them across the entire backtest window — a **look-ahead** violation. The results below should be treated as preliminary and re-run after the fundamentals refresh and `signal-quality.ts` cleanup.

- **Soft gate (Q ≥ 1.5):** ✅ Tentatively viable in backtest, but subject to data-quality caveats above.
- **Hard gate (≥ 2.0):** ❌ Not recommended based on current data.
- **Live status:** not promoted as a production BUY gate; production remains advisory-only quality overlay.

Run the sweep yourself:
```bash
pnpm run backtest -- --quality-floor 1.5 --from 2023-01-01 --to 2025-12-31
```

---

## Troubleshooting: native SQLite build

If **`better-sqlite3`** fails to compile (e.g. **`'climits' file not found`** on macOS), see the detailed **SDK / `CXX` single-path** instructions in the previous README section — the fix is **`pnpm install --ignore-scripts`**, set **`SDKROOT`** + **`CXXFLAGS`**, then **`pnpm run rebuild:native`**.

---

## Disclaimer

> This software is for **personal research and education** only. It is **not** investment advice. The authors are not responsible for trading losses. US market data may lag vendor publication; always verify prices and filings with your broker and official sources.

---

*License: not specified in this repository; confirm with the maintainer.*
