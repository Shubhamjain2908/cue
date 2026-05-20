## Cue — State of the Union Architecture Document
*Session Migration Handoff · May 2026 · End of Phase 3 Build Sprint*

---

## 1. Core Stack & Philosophy

**Runtime:** Node.js 22+, TypeScript strict ESM, `tsx` for execution.
**DB:** SQLite via `better-sqlite3`. No ORM. Raw prepared statements only.
**HTTP:** `axios` exclusively — no `fetch`, no `got`. Stack consistency with fetcher.
**Validation:** `zod` for all external data boundaries (LLM output, API responses).
**Testing:** `vitest`.
**Logging:** `winston` — structured JSON to stdout. **`pipeline`** logger for scheduled / subprocess pipeline; **`cue-cli`** logger for `src/cli.ts` subcommands.
**Package Manager:** `pnpm`.

**Philosophy:** Minimal dependency surface. No Express, no React, no ORMs, no cron libraries. Every capability implemented with Node.js builtins or the locked stack above. Single-file HTML dashboard output. Manual execution via IndMoney app — Cue signals, human executes.

**Market:** Nasdaq 100 universe. US Equities only. EOD data only — no intraday.
**Infra Budget:** ~$10/month VPS target.

---

## 2. Strategy Engine (LOCKED — DO NOT MODIFY)

**Factor:** Jegadeesh-Titman 12-1 Cross-Sectional Momentum.
**Formula:** `(close[today-21] - close[today-252]) / close[today-252]`
**Universe:** Nasdaq 100 (currently 7-ticker dev subset during build).
**Regime Filter:** QQQ > SMA(200). If false → suppress all new BUY signals. SELL/stop evaluation continues regardless.
**Rebalance:** Weekly, Friday EOD (`REBALANCE_DAY_OF_WEEK = 5`).
**Entry:** Top 3 tickers by momentum rank (`topN = 3`).

**ATR Trailing Stop (Close-based):**
- Period: ATR(14)
- Base multiplier: `4.0x` ATR
- Tight multiplier: `1.5x` ATR — triggered when unrealized profit ≥ 25%
- Golden Rule: stop never moves down

**Failsafe:** `MAX_HOLD_DAYS = 40`.

**Validated Backtest Benchmarks (Phase 1 Gate — LOCKED):**

| Metric | Result | Gate |
|---|---|---|
| CAGR | 21.39% | > 12% |
| Max Drawdown | 11.54% | < 20% |
| Sharpe Ratio | 1.162 | > 1.0 |
| Expectancy | +4.78% | > 0 |

*Test window: 2023-01-01 → 2025-12-31. Do not accept engine modifications that degrade these.*

---

## 3. Pipeline Architecture

### Unified CLI (`src/cli.ts`)

All operational entry points go through **`pnpm run cue <subcommand>`** (Commander). Examples: `cue ingest`, `cue screen`, `cue enrich`, `cue brief`, `cue execute-stops`, `cue run-all`, `cue schedule`, `cue doctor`, `cue db:migrate`. Use `pnpm run cue --help` and `pnpm run cue <cmd> --help` for flags.

### Run Modes (`src/agents/daily-workflow.ts`)

| Mode | Trigger | Steps (subprocesses = `pnpm run cue -- …`) |
|---|---|---|
| `rebalance` | Friday EOD (America/New_York) or `--force-rebalance` | ingest → screen → enrich → brief |
| `stop` | Mon–Thu | ingest → screen → brief |

`brief` builds `dist/dashboard.html` and runs Telegram dispatch (`--mode rebalance|stop` forwarded).

### Step registry (`PIPELINE_STEPS` in `daily-workflow.ts`)

Each step is a `PipelineStep`: `name`, `cueArgs` (argv after `pnpm run cue --`), `critical`, `runOn`, optional `forwardArgs` (e.g. `--mode` → `--mode <resolved>`).

**Criticality (current):** `ingest` + `screen` critical; `enrich` non-critical; `brief` non-critical (alerts must not block dashboard delivery).

### Module map (canonical paths)

| Concern | Path | CLI |
|---|---|---|
| CLI router | `src/cli.ts` + `src/cli/cue-logger.ts` + `src/cli/doctor.ts` | `pnpm run cue …` |
| Ingest | `src/ingestors/massive-price-ingestor.ts` | `cue ingest` / `pnpm run ingest` |
| Fundamentals (Phase 4) | `src/ingestors/enrich-fundamentals-cli.ts` + `src/llm/yahooContext.ts` | `cue enrich-fundamentals` |
| Screen / stops | `src/analysers/momentum-screener.ts` | `cue screen`, `cue execute-stops` |
| LLM enrich | `src/agents/thesis-generator.ts` + `src/llm/enricher.ts` | `cue enrich` |
| Alerts + dashboard | `src/briefing/telegram-dispatcher.ts`, `src/briefing/dashboard.ts` | `cue brief`, `cue brief:alert`, `cue brief:dashboard` |
| Pipeline / scheduler | `src/agents/daily-workflow.ts` | `cue pipeline`, `cue pipeline --now`, `cue schedule`, `cue run-all` |
| Backtest | `src/backtest/runner.ts` | `pnpm run backtest` |

### Scheduler (daemon mode)

`cue schedule` (or `cue pipeline` without `--now`) starts a `setInterval` polling loop (60s tick). On each tick:
1. Compute current ET time via `Intl.DateTimeFormat` (no moment/luxon).
2. Check execution window: `16:05–16:15 ET`.
3. Idempotency guard: `lastRunDate: string` (YYYY-MM-DD) — skip if already ran today.
4. Dispatch `runPipeline(mode)` when window + date conditions met.

**Graceful shutdown:** `SIGINT`/`SIGTERM` handlers call `process.exit(0)`.

---

## 4. Data Layer

### Ingest (`src/ingestors/massive-price-ingestor.ts`)

- **Source:** Massive.com REST API (`POLYGON_API_KEY` env var — legacy name retained).
- **Range:** ~400 calendar days lookback from range end. Guarded under Massive aggregate limits.
- **Cache guard:** Disk OHLCV cache + `MAX(date) FROM daily_prices` vs expected last trading session.
- **Known data lag:** Massive.com posts EOD data with ~1–2 day lag. `asOf` in the screen reflects last available bar.

### Migrations (`src/db/migrations/`)

- **DDL:** Numbered `*.sql` files only; ledger table `_migrations` records applied ids.
- **Runner:** `src/db/migrations/migrate.ts`; **`src/db/schema.ts`** re-exports `initSchema` / `migrateTracked` for app entry and `pnpm run db:init`.

### LLM enrichment (`src/llm/` + `src/agents/thesis-generator.ts`)

- **Context source:** `yahoo-finance2` via `src/llm/yahooContext.ts` — news, earnings calendar, sector, market cap (JSON cache under `CACHE_DIR`).
- **Providers:** `src/llm/provider.ts` + env `LLM_PROVIDER` (`anthropic` \| `openai` \| `google` \| `vertex`).
- **Hallucination guard:** Zod schemas on model output; bounded prompts.

---

## 5. Key SQLite Tables (`db/cue.db`)

- **`daily_prices`** — `(ticker, date)` UNIQUE. Massive.com OHLCV bars.
- **`signals`** — BUY/SELL signals. BUY rows denormalized with momentum context: `momentum_rank`, `universe_ranked_count`, `momentum_12_1_return`, `atr14`, `initial_atr_stop`, `alerted` flag.
- **`enrichments`** — Per-signal LLM output: `sentiment`, `rationale`, `earnings_date`, `sector`, `confidence`.
- **`positions`** — Live position tracker: `entry_date`, `entry_price`, `exit_date`, `highest_close_since_entry`, `current_stop_loss`.
- **`fundamentals_cache`** — Phase 4 placeholder table for persisted fundamentals blobs (`ticker`, `as_of_date`); population TBD.
- **`_migrations`** — Applied SQL migration ids.

*Schema source files live under `src/db/migrations/`.*

---

## 6. Environment Variables

| Variable | Description |
|---|---|
| `POLYGON_API_KEY` | Massive.com REST API key |
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `google` (default: `anthropic`) |
| `ANTHROPIC_API_KEY` | Required if provider = anthropic |
| `OPENAI_API_KEY` | Required if provider = openai |
| `GOOGLE_AI_API_KEY` | Required if provider = google |
| `TELEGRAM_BOT_TOKEN` | Telegram bot credentials |
| `TELEGRAM_CHAT_ID` | Telegram target chat |

---

## 7. Completed Phases

| Phase | Deliverable | Status |
|---|---|---|
| 1 — Core Engine | 12-1 Ranker + ATR stops + backtest validation | ✅ LOCKED |
| 2 — AI & Alerts | LLM enrichment + Telegram alerts | ✅ LOCKED |
| 3 — Dashboard | Static HTML dashboard + pipeline orchestrator | ✅ Functionally complete — VPS deployment pending |

---

## 8. Known Issues & Status

| # | Severity | Issue | Status |
|---|---|---|---|
| 1 | LOW | `rankedUniverse=0` logged on stop runs (misleading — ranking intentionally skipped) | Open — cosmetic fix pending |
| 2 | FIXED | `--force-rebalance` not propagating from pipeline to screen subprocess | ✅ Fixed via `forwardArgs` in step registry |
| 3 | FIXED | Fetcher cache guard checked request recency, not DB currency — stale data on Mondays | ✅ Fixed via `MAX(date)` vs `expectedLastTradingDate` |
| 4 | FIXED | Massive.com 499-bar cap truncating recent closes — range was 5yr, now 400 days | ✅ Fixed |
| 5 | FIXED | BUY Telegram noise on stop runs | ✅ `brief` forwards `--mode`; dispatcher suppresses BUY sends when `mode=stop` |
| 6 | DATA | Massive.com 1–2 day EOD data lag — `asOf` trails real date | Accepted limitation — not fixable in code |
| 7 | DATA | `GOOGL BUY 2026-05-19 alerted=1` was sent prematurely by a stop run | Needs manual DB reset: `UPDATE signals SET alerted=0 WHERE ticker='GOOGL' AND signal_date='2026-05-19'` |

---

## 9. Immediate Next Steps (Phase 3 Completion)

### 9.1 — Follow-ups

- **Fundamentals cache:** wire `cue enrich-fundamentals` output into `fundamentals_cache` rows (migration + queries).
- **Systemd:** replace ad-hoc PM2 notes with `cue.service` if moving off PM2 (see §9.2).

### 9.2 — TODO: VPS Deployment (Phase 3 Gate)
- Write `cue.service` systemd unit file
- `EnvironmentFile` for secrets (not inline env vars)
- `Restart=on-failure`, `RestartSec=30`
- Logs via `journald` (stdout → systemd)
- `systemctl enable cue` for boot persistence
- Target OS: **confirm in next session**

### 9.3 — TODO: Winston File Transport (optional but recommended)
- Add rotating file output: `logs/cue.log`
- 14-day retention
- Independent paper trail from journald

### 9.4 — COSMETIC: Fix misleading `rankedUniverse=0` log on stop runs

---

## 10. Documents to Attach in Next Session

**Required:**
- `db-schema.md` — exported SQLite schema (all tables, columns, constraints, indexes)

**Recommended:**
- This document (`state-of-union.md`)

**Retire after next session:**
- `Cue_Spec_v1.4.md` and `session_handoff.md` are now **superseded** by this document. They contain outdated parameter references (`topN=5`, `ATR 2.0x`, `15%` trigger) that conflict with locked values. **Do not attach them in the next session** — they will create contradictions. This SoU doc is the single source of truth going forward. If a formal spec is needed for external audiences, generate a clean `Cue_Spec_v2.0.md` from this document.

---

*End of State of the Union · Next session begins at §9.1*