# Cue — Project specification (engineering)

*Living document for this repository. **Do not edit** `spec/cue-architecture-v1.md` from here — it is the frozen narrative SoU; this file maps that intent onto **actual paths**, CLI, migrations, and post–Phase 3 behaviour (scheduler, ET constants, `llm-smoke`, registry split).*

**Also read:** root **`README.md`** (operator quickstart + full CLI matrix), **`spec/cue-db-schema.md`** (SQL snippets + read patterns + deferred items), **`.cursor/rules/db-schema.md`** (short table aligned to applied `src/db/migrations/*.sql`), **`.cursor/rules/cue-guardrails.md`** (hard rules).

---

## 1. What Cue is

Cue is a **personal US equity swing-trading signal engine** for the **Nasdaq 100**. It screens using **12-1 cross-sectional momentum**, enriches BUY candidates with **LLM** context, and delivers **Telegram** alerts plus a **static HTML** dashboard. **No automated execution** — you place orders manually (e.g. IndMoney).

**Relationship to Market Pulse AI:** Same operator may host both on one **Oracle Cloud** VM, but they are **separate repos**, **separate SQLite files**, and **separate PM2** apps. Market Pulse is **IST** / Indian equities; Cue is **`America/New_York`** civil calendar / US EOD.

---

## 2. Core stack (LOCKED)

| Concern | Choice |
|---|---|
| Runtime | Node.js **22+**, TypeScript **strict ESM**, **`tsx`** |
| Database | **SQLite** via `better-sqlite3`; no ORM; prepared statements in `src/db/queries.ts` |
| HTTP | **`axios` only** (no `fetch` / `got`) |
| Validation | **`zod`** at env, API, and LLM JSON boundaries |
| Logging | **`winston`** JSON to stdout — services: **`cue-cli`**, **`pipeline`**, **`scheduler`** |
| Tests | **vitest** |
| Package manager | **pnpm** (see `packageManager` in `package.json`) |
| Process manager (VPS) | **PM2** — `deploy/ecosystem.config.cjs` runs `tsx` on **`src/cli.ts`** (see §8) |

**Philosophy:** Small dependency surface — no Express, no React, no ORMs, no required cron library (scheduler uses `setInterval`). Single-file dashboard output under `dist/`.

**Market:** Nasdaq 100 + **QQQ** for regime. **EOD only** — no intraday.

**Infra:** Oracle Cloud Always Free–class VM is the design target (~**$10/mo** budget narrative in arch doc).

---

## 3. Strategy engine (LOCKED — do not modify without re-gating backtests)

### 3.1 Factor

**Jegadeesh–Titman 12-1 cross-sectional momentum**

```
momentum_12_1_return = (close[today-21] - close[today-252]) / close[today-252]
```

- **Universe:** tickers from `data/universe/nasdaq100.json` (plus **QQQ** for regime / data).
- **Entry:** top **3** names by momentum rank on rebalance.
- **Rebalance cadence:** **Friday** EOD in ET civil calendar (`REBALANCE_DAY_OF_WEEK = 5` in `daily-workflow.ts`).
- **Regime filter:** **QQQ close > SMA(200)**. If false → **suppress new BUYs**; SELL / stop paths still run.

### 3.2 ATR trailing stop (close-based)

- **Period:** ATR(14)
- **Base multiplier:** **4.0×** ATR  
- **Tight multiplier:** **1.5×** ATR when unrealized profit **≥ 25%**
- **Golden rule:** stop **never** moves down (`new_stop = MAX(candidate, current_stop_loss)` in application logic).

**Failsafe:** **`MAX_HOLD_DAYS`** (env, default **40**).

**Exit reasons (conceptual):** trailing stop, initial stop, time exit, manual — see screener / stop CLI.

### 3.3 Validated backtest benchmarks (Phase 1 gate — LOCKED)

| Metric | Result | Gate |
|---|---|---|
| CAGR | 21.39% | > 12% |
| Max drawdown | 11.54% | < 20% |
| Sharpe | 1.162 | > 1.0 |
| Expectancy | +4.78% | > 0 |

*Window: 2023-01-01 → 2025-12-31. Do not merge engine changes that fail these gates.*

---

## 4. Pipeline architecture

### 4.1 Unified CLI

All operations: **`pnpm run cue -- <subcommand>`**. Help: **`pnpm run cue -- --help`**. Full matrix: **`README.md`**.

### 4.2 Run modes (registry vs scheduler)

The **architecture v1** doc describes modes as `fetch → screen → …`. In **this repo**, the **ingest** step is `cue ingest`, and delivery is **`cue brief`** (dashboard + Telegram). Two orchestration layers exist:

| Mechanism | Source | When used | Steps (subprocess = `pnpm run cue -- …`) |
|---|---|---|---|
| **Registry `PIPELINE_STEPS`** | `src/agents/daily-workflow.ts` | `pnpm run cue -- run-all`, `pnpm run cue -- pipeline --now` | `detectRunMode()`: Friday → **`rebalance`**: ingest → screen → enrich → brief; else **`stop`**: ingest → screen → brief. |
| **Scheduler daemon** | `src/agents/scheduler.ts` | `pnpm run cue -- schedule`, `pnpm run cue -- pipeline` *(no `--now`)* | **ET window 16:05–16:15**, **`America/New_York`**, once per ET calendar day, **`isRunning`** lock. **Friday:** ingest → enrich-fundamentals → screen → enrich → brief (mode **`rebalance`** for `forwardArgs`). **Mon–Thu:** ingest → execute-stops → brief (mode **`stop`**). **Sat/Sun:** no chain. |

`pnpmRunArgs` / `resolvedForwardArgs` add **`--force-rebalance`** to **screen** when pipeline mode is `rebalance`, and **`--mode`** to **brief**.

### 4.3 Step type (`PipelineStep`)

```ts
// src/agents/daily-workflow.ts — conceptual shape
interface PipelineStep {
  name: string;
  cueArgs: string[];       // argv after `pnpm run cue --`
  critical: boolean;
  runOn: "rebalance" | "stop" | "both";
  forwardArgs?: string[]; // e.g. ["--mode"] → ["--mode", "<mode>"]
}
```

**Criticality (today):** **ingest** + **screen** = critical; **enrich** = non-critical; **brief** = non-critical (dashboard/alerts should not hard-block each other).

### 4.4 Scheduler tick sequence (`scheduler.ts`)

1. Resolve ET civil **date** / **time** via `Intl.DateTimeFormat` using **`CUE_LOCALE`** + **`CUE_TIME_ZONE`** from `src/config/cue-timezone.ts`.
2. If outside **16:05–16:15** ET → return.
3. If **`lastRunDate`** already recorded success for this ET **YYYY-MM-DD** → return.
4. If **weekend** (NY weekday 0 or 6) → return (debug log).
5. If **`isRunning`** → warn and return (no overlapping subprocess pipelines).
6. Else run **`runPipelineWithSteps`** for Friday vs Mon–Thu lists; on exit code **0**, set **`lastRunDate`**.

**Startup / shutdown:** readonly DB **`SELECT 1`** for health; keep handle until **`SIGINT`/`SIGTERM`**: clear interval, **close** DB, **`process.exit(0)`**.

### 4.5 Alert / brief mode gating (Phase 3 behaviour)

`src/briefing/telegram-dispatcher.ts` consumes **`--mode rebalance|stop`**. **BUY** alerting is gated for **rebalance**-style runs; **stop** runs should not spam BUY Telegram noise (see dispatcher + `brief` forwarding). Invalid/missing mode should fail loudly in those code paths.

---

## 5. Module map (canonical)

| Concern | Path | CLI / entry |
|---|---|---|
| CLI | `src/cli.ts`, `src/cli/cue-logger.ts`, `src/cli/doctor.ts`, `src/cli/llm-smoke.ts` | `pnpm run cue -- …` |
| ET constants | `src/config/cue-timezone.ts` | `CUE_LOCALE`, `CUE_TIME_ZONE` |
| Env | `src/config/index.ts` | `getConfig()` |
| Ingest | `src/ingestors/massive-price-ingestor.ts` | `cue ingest` |
| Fundamentals cache CLI | `src/ingestors/enrich-fundamentals-cli.ts` + `src/llm/yahooContext.ts` | `cue enrich-fundamentals` |
| Screen / stops | `src/analysers/momentum-screener.ts` | `cue screen`, `cue execute-stops` |
| LLM | `src/llm/provider.ts`, `src/llm/enricher.ts`, `src/llm/prompt.ts` | via `cue enrich` |
| Thesis batch | `src/agents/thesis-generator.ts` | `cue enrich` |
| Registry pipeline | `src/agents/daily-workflow.ts` | `cue run-all`, `cue pipeline --now` |
| Scheduler | `src/agents/scheduler.ts` | `cue schedule`, `cue pipeline` |
| Briefing | `src/briefing/dashboard.ts`, `src/briefing/telegram-dispatcher.ts`, `src/briefing/queries.ts` | `cue brief`, `brief:dashboard`, `brief:alert` |
| DB | `src/db/migrations/*.sql`, `migrate.ts`, `queries.ts`, `provider.ts` | `cue db:migrate`, `db:init` |
| Backtest | `src/backtest/runner.ts` | `pnpm run backtest` |

---

## 6. Data layer

### 6.1 Prices — Massive.com

- **Env:** `POLYGON_API_KEY` (legacy name; Massive / Polygon-compatible key).
- **Client:** `src/ingestors/massive-price-ingestor.ts` — per-ticker aggs; **~400 calendar days** lookback (under vendor bar caps).
- **Cache guard:** disk cache + **`MAX(date)`** in `daily_prices` vs expected last **US** session (ET-aware helpers share **`cue-timezone`** constants).
- **Lag:** vendor EOD often **1–2 sessions** behind — `asOf` in logs is **last bar**, not “yesterday” by wall clock.

**Rate limit risk (from arch v1):** full **100** tickers × daily = many REST calls. **Grouped daily** endpoint migration is still a **scaling** task before aggressive automation (see §12).

### 6.2 Enrichment context — Yahoo

- **`yahoo-finance2`** via `src/llm/yahooContext.ts`; JSON under **`CACHE_DIR`**.

### 6.3 LLM providers

- **`src/llm/provider.ts`**: **`anthropic` | `openai` | `google` | `vertex`** (Vertex uses `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `VERTEX_MODEL`).
- **Contract:** `LLMProvider.complete(messages, maxTokens)`; structured output = **parse JSON + Zod** (`tryParseModelJson`, schemas in `types.ts` / enricher).
- **Smoke:** `cue llm-smoke` → `src/cli/llm-smoke.ts`.

---

## 7. Schema & migrations

- **Applied DDL:** `src/db/migrations/001_initial_schema.sql`, `002_create_fundamental_cache.sql`; ledger **`_migrations`**.
- **Includes today’s repo:** `signals` **`UNIQUE (ticker, date, signal, signal_type)`** with default **`signal_type = 'MOMENTUM'`**; `positions` includes **`highest_close_since_entry`**, **`current_stop_loss`** (arch “S1/S2” **implemented** here; `spec/cue-db-schema.md` may still describe an older deployed snapshot — trust **`src/db/migrations`** first).
- **`fundamentals_cache`:** table exists; CLI still primarily writes **disk** cache — DB upsert wiring is a follow-up.
- **Extended SQL / read patterns / deferred `backtest_trades`:** **`spec/cue-db-schema.md`**.

---

## 8. Deployment

- **VM:** Oracle Cloud (e.g. `VM.Standard.E2.1.Micro`, Ubuntu) — same *class* of host as arch doc; **independent** PM2 process from Market Pulse.
- **Repo layout on server:** e.g. `/opt/cue`; secrets **`chmod 600`** `.env`; PM2 **`env_file`**.
- **Process:** `deploy/ecosystem.config.cjs` uses **`node_modules/.bin/tsx`** with args **`src/cli.ts pipeline`** (no `--now` → **scheduler**). Prefer **`src/cli.ts schedule`** in args for clarity.
- **Logs:** PM2 `out_file` / `error_file` under `logs/` (see ecosystem).

---

## 9. Guardrails

Hard rules: **`.cursor/rules/cue-guardrails.md`** (*v1.1+ — enforcement paths match this repo*). Topics: QQQ SMA200 gate, momentum formula lock, ATR golden rule, pipeline criticality, **scheduler `isRunning` + `lastRunDate`**, LLM Zod validation, ingest DB currency guard, Telegram `--mode` behaviour.

## 10. Environment variables

See **`src/config/index.ts`** for the full **`zod`** schema. Highlights:

| Variable | Role |
|---|---|
| `POLYGON_API_KEY` | Massive REST |
| `DB_PATH`, `CACHE_DIR`, `UNIVERSE` | Storage / universe label |
| `LLM_PROVIDER`, provider keys, `VERTEX_*`, `LLM_MAX_TOKENS` | LLM |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Alerts |
| `LOG_LEVEL` | Winston |
| Position / RSI / ATR params | `MAX_POSITIONS`, `POSITION_SIZE_USD`, `STOP_LOSS_PCT`, `MAX_HOLD_DAYS`, `SMA_PERIOD`, etc. |

---

## 11. Phase history

| Phase | Deliverable | Status |
|---|---|---|
| 1 — Core engine | 12-1 ranker + ATR + backtest gate | ✅ LOCKED |
| 2 — AI & alerts | LLM enrich + Telegram | ✅ LOCKED |
| 3 — Dashboard + pipeline | HTML dashboard + **`daily-workflow`** registry + **`cue brief`** | ✅ Complete |
| 3+ — Ops hardening (this repo) | **`scheduler.ts`** ET window, Fri vs Mon–Thu routes, **`isRunning`**, **`cue-timezone`**, **`llm-smoke`**, README / rules | ✅ Shipped here |

---

## 12. Known issues & tracker

| ID | Severity | Issue | Status |
|---|---|---|---|
| S4 | **HIGH** | Massive **free-tier / call count**: per-ticker daily fetch × full universe may hit limits — migrate to **grouped daily** endpoint (arch §6.1) | Open — scaling |
| S5 | LOW | `rankedUniverse=0` log on stop runs (misleading) | Open — cosmetic |
| S6 | LOW | No `backtest_trades` table — run-level stats only | Deferred (see `spec/cue-db-schema.md`) |
| — | DATA | Massive EOD **lag** 1–2d | Accepted |
| — | FIXED (repo) | `--force-rebalance` not reaching screen | ✅ `forwardArgs` / `pnpmRunArgs` |
| — | FIXED (repo) | Ingest cache used request time not **DB** max date | ✅ `MAX(date)` guard |
| — | FIXED (repo) | BUY Telegram noise on stop | ✅ `--mode stop` + dispatcher |
| — | FIXED (arch S3) | Scheduler overlap | ✅ **`isRunning`** in `scheduler.ts` |
| — | FIXED (arch S1/S2) | Positions columns + signals uniqueness | ✅ **`001_initial_schema.sql`** |

---

## 13. Phase 4+ engineering backlog (from arch §11, reconciled)

| Task | Notes |
|---|---|
| **Grouped Massive fetch** | Reduce REST calls for 100 names / day |
| **Wire `fundamentals_cache`** | From `enrich-fundamentals` into SQLite |
| **Cosmetic logs** | `rankedUniverse=0` on intentional skip |
| **`backtest_trades`** | Per-trade audit (Phase 5 spec) |
| **Quality-GARP** (research) | Arch doc: backtest before any new production screener |
| **systemd unit** | Optional alternative to PM2 (`cue.service`, `EnvironmentFile=`) |
| **Winston file transport** | Optional rotating `logs/cue.log` |

---

## 14. Document index

| Document | Role |
|---|---|
| `spec/cue-architecture-v1.md` | **Frozen** narrative SoU + Phase 4 plan wording — **do not edit in Cursor tasks unless the user explicitly asks** |
| `spec/cue-db-schema.md` | Deep schema narrative, example queries, deferred migrations |
| `.cursor/rules/db-schema.md` | Short agent summary tied to **applied** migrations |
| `.cursor/rules/cue-guardrails.md` | Hard constraints (**paths aligned to this repo** in v1.1) |
| `README.md` | Operator-facing commands + quickstart |
| `.cursor/rules/project-spec.md` | **This file** — repo-accurate engineering spec |
| `.cursor/rules/cue-claude-instructions.md` | **Claude / Cursor agent** role, SoU reading order, stack, workflow directives, path map |

---

*End of project-spec — prefer `src/db/migrations` and `src/agents/*.ts` over prose when in doubt.*
