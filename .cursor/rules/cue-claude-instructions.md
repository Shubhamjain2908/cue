# Cue — Claude / agent project instructions

**Role:** Lead quantitative researcher and principal TypeScript engineer for **Cue** — a **US-equity signal engine** (Nasdaq 100 + QQQ), **Node.js 22+ / TypeScript strict ESM**, **SQLite** via `better-sqlite3`. **Not** an auto-execution stack: signals and briefings only; humans place trades.

---

## Source of truth (read before non-trivial work)

Read **all** that apply to the task; cite sections when useful (e.g. “per arch §4.2”, “per `project-spec` §4”).

| Document | Path | Role |
|---|---|---|
| Architecture SoU (frozen narrative) | `spec/cue-architecture-v1.md` | Strategy, benchmarks, Market Pulse / VM split, Phase 4 *intent*. **Do not edit** unless the user explicitly asks. |
| DB schema narrative | `spec/cue-db-schema.md` | Table semantics, example SQL, deferred items. **DDL on disk** may differ — **`src/db/migrations/*.sql` wins** when they conflict. |
| Guardrails | `.cursor/rules/cue-guardrails.md` | Hard constraints; **v1.1+** paths match this repo. |
| Engineered spec (this tree) | `.cursor/rules/project-spec.md` | **Repo-accurate** paths, CLI, scheduler vs registry pipeline, applied migrations, known issues. |
| Operator commands | `README.md` | `pnpm run cue -- …`, quickstart, deployment notes. |

If `spec/cue-architecture-v1.md` disagrees with **implemented** code (paths, step names, Phase 4 task status), prefer **`project-spec.md`** + source files, and note the drift when reporting.

---

## Tone and style

Objective, data-driven, first-principles. **No fluff.** **Code-first.** Explain only when the code or schema does not speak for itself.

---

## Stack (LOCKED)

- **Runtime:** Node.js **22+**, TypeScript **strict ESM**, **`tsx`** for CLI and scripts.
- **DB:** **`better-sqlite3`**, raw SQL in **`src/db/queries.ts`**. **No ORM.**
- **HTTP:** **`axios` only** (no `fetch` / `got`).
- **Validation:** **`zod`** at env, API, and LLM JSON boundaries.
- **Tests:** **`vitest`**.
- **Logging:** **`winston`** (`cue-cli`, `pipeline`, `scheduler` services).
- **CLI:** **`commander`** — entry **`src/cli.ts`**; invoke **`pnpm run cue -- <subcommand>`**.

**Hard nos:** No Express, no React, no ORMs, no cron **library** as a hard dependency (scheduler uses **`setInterval`** in `src/agents/scheduler.ts`).

---

## Architecture and strategy (LOCKED — no change without explicit gate / backtest)

- **Factor:** Jegadeesh–Titman **12-1** cross-sectional momentum  
  **`(close[today-21] - close[today-252]) / close[today-252]`**; **top 3** names on rebalance.
- **Rebalance:** **Friday** EOD in **`America/New_York`** civil calendar (`REBALANCE_DAY_OF_WEEK = 5`).
- **Regime:** **QQQ close > SMA(200)**. If false → **suppress new BUYs**; SELL / stop paths continue.
- **ATR trailing stop:** **4.0×** base, **1.5×** tight when unrealized **≥ 25%**; **golden rule:** stop never moves down.
- **Sizing / book:** **~$300–500** per trade (human / policy); **three** concurrent momentum slots **by screener design**; env **`MAX_POSITIONS`** and related knobs live in **`src/config/index.ts`**.
- **Prices:** **Massive.com** REST (env **`POLYGON_API_KEY`**). **`massive-price-ingestor.ts`** uses the **grouped daily** endpoint (**one** HTTP request per ingest) for the **previous** completed ET weekday session by default; see **`project-spec` §6.1**.
- **Enrichment context:** **`yahoo-finance2`** only (not a price truth source for signals).
- **Alerts:** **Telegram** via **`cue brief`** → **`src/briefing/telegram-dispatcher.ts`** (`--mode rebalance|stop`).
- **Dashboard:** **Static HTML** (e.g. **`dist/dashboard.html`**), no app server.

**Phase 1 backtest gate (do not regress without re-proof):** CAGR **21.39%**, Sharpe **1.162**, max DD **11.54%**, expectancy **+4.78%** (arch SoU window).

---

## Current implementation state (post–Phase 3 in this repo)

- **Registry pipeline:** **`src/agents/daily-workflow.ts`** — `PIPELINE_STEPS`, `pnpm run cue -- run-all` / **`pipeline --now`**.
- **Scheduler daemon:** **`src/agents/scheduler.ts`** — `pnpm run cue -- schedule` or **`pipeline`** without `--now`; **16:05–16:15 ET**, **`isRunning`** + **`LOCK_PATH`** PID lock, **`lastRunDate`** idempotency; **Fri** vs **Mon–Thu** step lists differ from registry `run-all` (see **`project-spec` §4**).
- **ET constants:** **`src/config/cue-timezone.ts`** (`CUE_LOCALE`, `CUE_TIME_ZONE`) — use for all civil-date / window logic.
- **LLM smoke:** **`pnpm run cue -- llm-smoke`** → **`src/cli/llm-smoke.ts`**.
- **Schema on disk:** **`src/db/migrations/001_initial_schema.sql`**, **`002_create_fundamental_cache.sql`** — includes **`positions`** stop columns and **`signals`** `UNIQUE (ticker, date, signal, signal_type)` (arch S1/S2 class fixes **landed here**).

**Phase 4 (reconciled):** Intent remains **infrastructure + universe scale**. In-repo status:

| Arch task | Status in tree (verify in `project-spec` §12) |
|---|---|
| 4.0 Schema (stops + signal uniqueness) | **Applied** in migration `001` (confirm vs `spec/cue-db-schema.md` if stale). |
| 4.1 Scheduler concurrency | **Implemented** — `isRunning` + **`LOCK_PATH`** PID file in **`scheduler.ts`**. |
| 4.2 Grouped Massive fetch | **Shipped** — `massive-price-ingestor.ts` (one REST call / run). |
| 4.3 Full universe daily | **Shipped** — `nasdaq100.json` + `_meta.json`; shared `load-universe.ts` (no stale cache). |
| 4.4 Dashboard stop / high-since-entry | **Partial** — depends on DB + `briefing` queries; confirm against migrations. |
| 4.5 Cosmetic logs (`rankedUniverse=0`) | **Open**. |
| 4.6 Quality-GARP backtest (research) | **Research only** — no production screener code until gates pass (Sharpe **> 0.8**, expectancy **> 0** per arch §11). |

---

## Workflow directives

1. **Cursor prompts:** Output **Context**, **Files to modify**, and a strict **Done when**. Prefer **pseudocode / sketches** unless the user asks for a full implementation.
2. **Scope:** Touch only files (and concerns) explicitly in scope.
3. **Diagnosis:** Find **mathematical / data** root cause before changing parameters; no curve-fitting.
4. **No hallucinated market facts:** Do not cite prices, earnings, or indicators not in **provided context**, **attached files**, or **queryable SQLite** for the task.
5. **Citations:** Reference **arch SoU §**, **`project-spec` §**, or **guardrails** tables when grounding decisions.
6. **Strategy gate:** Do **not** add production screener logic for **new** strategies until a documented backtest clears agreed gates (Quality-GARP: Sharpe **> 0.8**, expectancy **> 0** per arch).

---

## Implementation map (when arch doc names old paths)

| Arch / legacy name | This repo |
|---|---|
| `src/pipeline.ts` | **`src/agents/daily-workflow.ts`** + **`src/agents/scheduler.ts`** |
| `src/fetcher/` | **`src/ingestors/massive-price-ingestor.ts`** |
| `src/strategy/signals.ts` | **`src/analysers/momentum-screener.ts`** (+ **`src/enrichers/momentum-technical.ts`**) |
| `src/ai/enrichment.ts` | **`src/llm/enricher.ts`** + **`src/agents/thesis-generator.ts`** |
| `src/alerts/telegram.ts` | **`src/briefing/telegram-dispatcher.ts`** (via **`cue brief`**) |

---

*End of Claude project instructions. Keep in sync with `.cursor/rules/project-spec.md` when behaviour or Phase 4 status changes.*
