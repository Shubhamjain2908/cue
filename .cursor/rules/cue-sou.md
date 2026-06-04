# Cue — Project specification (engineering)

*Living document for this repository. Maps architecture intent onto **actual paths**, CLI, migrations, and **Phase 9b** behaviour (T-1 next-morning ingestor, 06:00 ET pipeline window, stop-replay correctness, SELL Telegram alerts, arch-review gap closure).*

**Also read:** root **`README.md`** (operator quickstart), **`.cursor/rules/cue-db-schema.md`** (migrations `001`–`016`), **`.cursor/rules/cue-guardrails.md`** (hard rules).

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

- **Universe:** tickers from `data/universe/nasdaq100.json` (resolved via env **`UNIVERSE`**, default `nasdaq100`) plus **`data/universe/_meta.json`** for human-readable as-of / count checks; **QQQ** added at runtime for regime / ingest (see `_meta.json` → `system_additions`).
- **Entry:** top **3** names by momentum rank on rebalance.
- **Rebalance cadence:** **Sunday 06:00–06:10 ET** (`REBALANCE_DAY_OF_WEEK = 0` in `daily-workflow.ts`) using **Friday** session OHLCV (T-1 from Massive); **Tue–Sat** runs **execute-stops** at **06:00–06:10 ET** (next-morning cadence; Monday is idle).
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
| CAGR | 21.82% | > 12% |
| Max drawdown | 10.51% | < 20% |
| Sharpe | 1.198 | > 1.0 |
| Expectancy | +4.945% | > 0 |

*Window: 2023-01-01 → 2025-12-31. Locked run **`backtest_runs` id=82** (PR-6 ceremony 2026-06-04 — `REBALANCE_DROP` exit-reason mapping fix in `closedTradeToDbExit`; supersedes id=81 which misclassified 56 rotation exits as `MANUAL`). See `spec/cue-handoff.md` §2.2. Any engine change that moves a gate metric >1% requires re-run + lock rotation.*

---

## 4. Pipeline architecture

### 4.1 Unified CLI

All operations: **`pnpm run cue -- <subcommand>`**. Help: **`pnpm run cue -- --help`**. Full matrix: **`README.md`**.

### 4.2 Pipeline routes (by ET weekday)

| Day | Mode | Steps (`pnpm run cue -- …`) |
|-----|------|-----------------------------|
| **Sunday** | `rebalance` | ingest → adjust-splits → enrich-fundamentals → screen → enrich → brief `--mode rebalance` |
| **Tuesday–Saturday** | `stop` | ingest → adjust-splits → execute-stops → brief `--mode stop` |
| **Monday** | — | skip (idle) |

**Registry** (`daily-workflow.ts`): `REBALANCE_DAY_OF_WEEK = 0` (Sunday) → `rebalance`; Tuesday–Saturday (dow 2–6) → `stop`; Monday (dow 1) → idle. **`--force-rebalance`** overrides any day.

**Scheduler** (`scheduler.ts`): runs the same step lists inside the 06:00–06:10 ET window (§4.4); uses `stepsForMode("rebalance" | "stop")` from the registry — no duplicated step arrays.

**Healthcheck** (`healthcheck.ts`): PM2 cron **~07:00 ET** Sun/Tue–Sat (`0 11 * * 0,2,3,4,5,6` UTC — fires after the 06:00 ET pipeline window). Checks: `daily_prices` currency, `ingest_staleness`, QQQ lag, stale OPEN positions, pipeline output for today's ET session, and **`pipeline_step_state`** (critical step exit codes from `pipeline_state` — not PM2 log grep).

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

**Criticality (today):** **ingest** + **screen** (rebalance) or **execute-stops** (stop) = critical; **adjust-splits** = non-critical (Yahoo outage must not block stops/screen); **enrich** = non-critical; **brief** = non-critical (dashboard/alerts should not hard-block each other).

### 4.4 Scheduler tick sequence (`scheduler.ts`)

**Weekend / weekday gate (ET civil calendar, `getETDayOfWeek()`):**

| `dayOfWeek` | Day | Action |
|-------------|-----|--------|
| `0` | Sunday | **rebalance** window **06:00–06:10 ET** |
| `1` | Monday | idle (skip) |
| `2`–`6` | Tue–Sat | **stop** window **06:00–06:10 ET** |

1. Resolve ET civil **date** / **time** via `Intl.DateTimeFormat` using **`CUE_LOCALE`** + **`CUE_TIME_ZONE`** from `src/config/cue-timezone.ts`.
2. If outside the active window (`isWithinExecutionWindow`) for today's mode → return.
3. If **`pipeline_state`** key **`last_successful_run_date`** already equals this ET **YYYY-MM-DD** (SQLite via `getPipelineState`) → return.
4. `schedulerRunKindForNyWeekday(dow)`: `0` → `"rebalance"`, `2–6` → `"weekday"`, `1` → `null` (idle).
5. If **`isRunning`** → warn and return (no overlapping subprocess pipelines in one process).
6. If **`LOCK_PATH`** is held by a **live** PID (`process.kill(pid, 0)`) → warn and return; else acquire PID lock (unlink stale file if PID is dead).
7. On startup: `verifyMigrations(heldDb)` checks **`HEAD_MIGRATION = "016_signals_alerted_at"`** is applied — exits 2 if not.
8. Run **`runPipelineWithSteps(stepsForMode("rebalance" | "stop"), mode, heldDb)`** — after each subprocess step, writes **`step:{name}:last_exit_code`** and **`step:{name}:last_run_at`** to **`pipeline_state`**; on pipeline exit code **0** only, also writes **`last_successful_run_date`**; always clear **`isRunning`** and release **`LOCK_PATH`** in `finally`.

**Startup / shutdown:** parent **`heldDb`** via **`openCueDb`** (read-write, applies WAL + pragmas via `applySqlitePragmas`) for health **`SELECT 1`**, **`pipeline_state`** reads/writes, and clean shutdown; **`LOCK_PATH`** stale lock cleared on startup if holder PID is dead; subprocess **`cue`** steps open their own DB handles; keep **`heldDb`** until **`SIGINT`/`SIGTERM`**: clear interval, **release PID lock**, **close** DB, **`process.exit(0)`**.

### 4.5 Alert / brief mode gating (Phase 9b behaviour)

`src/briefing/telegram-dispatcher.ts` consumes **`--mode rebalance|stop`**.

- **Both modes:** First dispatch **SELL alerts** (`listSellSignalsReadyToAlert` — `signals` SELL + `alerted=0` + `exit_date > entry_date`, joined to BUY entry context). Formatted with exit reason emoji (🔴 TRAILING_STOP, 🔄 REBALANCE_DROP, ⏱ TIME_EXIT, ✋ MANUAL), entry/exit prices, and P&L %. Each marked `alerted=1` + `alerted_at = CURRENT_TIMESTAMP` after send.
- **`rebalance`** → SELL alerts → formatted **BUY** alerts from **`signals`** plus optional **`enrichments`** (`INNER JOIN` for ready-to-alert BUYs in `src/db/queries.ts`). The message is order-ready: entry range (±1%), stop, 1R target, position size, sector / earnings, and a trimmed rationale. Share sizing is ATR-normalised when **`PORTFOLIO_VALUE_USD`** is set, with fallback to **`POSITION_SIZE_USD`** (capped at 5% of implied book via `deriveBuyAlertShares`). Then, when **`WATCHLIST_BENCH_DEPTH` > 0**, send a second Telegram message **"Next in Rank"** for unalerted **`WATCHLIST`** rows on the session `asOf` (rank, 12-1 fraction, sentiment/sector from enrichment — up to 3 sentences / 280 chars).
- **`stop`** → SELL alerts → **Daily Pulse** (`sendDailyPulse(db, sellCount)`). **Suppressed** when there are 0 OPEN positions **and** `sellCount === 0`. Otherwise: reads OPEN positions + latest `daily_prices.close`, computes unrealised P&L, labels stops **BASE** vs **TIGHT**, flags **`⚠️ NEAR STOP`** when cushion < 0.5× ATR(14), shows next ET rebalance Friday.
- Invalid / missing `--mode` fails loudly.

---

## 5. Module map (canonical)

| Concern | Path | CLI / entry |
|---|---|---|
| CLI | `src/cli.ts`, `src/cli/cue-logger.ts`, `src/cli/doctor.ts`, `src/cli/llm-smoke.ts` | `pnpm run cue -- …` |
| ET constants | `src/config/cue-timezone.ts` | `CUE_LOCALE`, `CUE_TIME_ZONE` |
| Env | `src/config/index.ts` | `getConfig()` |
| Universe files | `data/universe/*.json`, `data/universe/_meta.json` | `UNIVERSE` env key; loader `src/universe/load-universe.ts` |
| Ingest | `src/ingestors/massive-price-ingestor.ts` | `cue ingest` |
| Corporate actions | `src/ingestors/corporate-actions.ts`, `scripts/backfill_historical_split_adjustments.ts` | `cue adjust-splits` (live splits); `cue backfill-splits` (one-shot replay of `corporate_actions` → `daily_prices`) |
| Fundamentals cache CLI | `src/ingestors/enrich-fundamentals-cli.ts` + `src/llm/yahooContext.ts` | `cue enrich-fundamentals` |
| Screen / stops | `src/analysers/momentum-screener.ts` | `cue screen`, `cue execute-stops` (optional `--date YYYY-MM-DD` = as-of session; default latest QQQ bar in DB) |
| LLM | `src/llm/factory.ts`, `src/llm/types.ts`, `src/llm/json.ts`, `src/llm/enricher.ts`, `src/llm/prompt.ts` | via `cue enrich` |
| Thesis batch | `src/agents/thesis-generator.ts` | `cue enrich` (pending **BUY**, then pending **WATCHLIST**; watchlist failures are warn-only) |
| Registry pipeline | `src/agents/daily-workflow.ts` | `cue run-all`, `cue pipeline --now` |
| Scheduler | `src/agents/scheduler.ts` | `cue schedule`, `cue pipeline` |
| Healthcheck | `src/agents/healthcheck.ts` | `cue healthcheck` |
| Briefing | `src/briefing/dashboard.ts`, `src/briefing/telegram-dispatcher.ts`, `src/briefing/queries.ts`, `src/briefing/template.ts` (`formatWatchlistBench`, `formatBacktestRef` + `window_label`) | `cue brief`, `brief:dashboard`, `brief:alert` *(rebalance BUY alerts + watchlist bench; stop-path Daily Pulse; dashboard Live Performance + **locked** MOMENTUM backtest ref)* |
| DB | `src/db/migrations/*.sql`, `src/db/migrate.ts` (re-exports runner), `queries.ts`, `provider.ts` | `cue db:migrate`, `db:init` |
| Backtest | `src/backtest/runner.ts` | `pnpm run backtest` |

---

## 6. Data layer

### 6.1 Prices — Massive.com

- **Env:** `POLYGON_API_KEY` (legacy name; Massive / Polygon-compatible key).
- **Client:** `src/ingestors/massive-price-ingestor.ts` — **one** Massive **grouped daily** REST call per `cue ingest` run. **Session date resolution (Phase 9):** tries **T+0** (today's ET weekday) first; if the API returns 0 bars (market holiday or data not yet published) or throws (403/rate-limit), falls back to **T−1** (previous ET weekday). `--date YYYY-MM-DD` bypasses this logic. `--force` refetches regardless of DB currency. After a successful primary insert, **auto-backfill** checks the last 5 ET weekdays for gaps in QQQ's `daily_prices` and fills them (chronological order; market holidays logged and skipped; only dates strictly before `primarySessionDate` attempted to avoid free-tier 403s).
- **Currency guard:** per-symbol **`MAX(date)`** in `daily_prices` vs expected last **US** session (ET-aware helpers share **`cue-timezone`** constants); no disk OHLCV cache on this path.
- **Lag:** vendor EOD often **1–2 sessions** behind — `asOf` in logs is **last bar**, not “yesterday” by wall clock.

**Historical depth:** prior **~400-day** per-ticker backfill is no longer performed by `cue ingest`; long lookbacks require rows already present in `daily_prices` (e.g. from earlier installs or a separate backfill).

### 6.2 Yahoo Finance (two call sites)

| Use | Module | Methods |
|-----|--------|---------|
| LLM enrichment / fundamentals CLI | `src/llm/yahooContext.ts` | `search()`, `quoteSummary()` — disk cache under **`CACHE_DIR`** |
| Corporate split events | `src/ingestors/corporate-actions.ts` | `chart()` — persisted in **`corporate_actions`** (`008`) |

### 6.3 LLM providers

- **`src/llm/factory.ts`**: **`anthropic` | `openai` | `google-studio` | `vertex` | `mock`** (legacy `google` env values normalize to `google-studio`; Vertex uses `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `VERTEX_MODEL`).
- **Contract:** `LlmProvider.generateText(...)` and `generateJson(...)`; structured output = shared JSON extraction + Zod validation via `src/llm/json.ts`.
- **Smoke:** `cue llm-smoke` → `src/cli/llm-smoke.ts`.

---

## 7. Schema & migrations

- **Applied DDL:** `001`–`016` under `src/db/migrations/` (ledger **`_migrations`**); authoritative column list in **`.cursor/rules/cue-db-schema.md`**.
- **Post-migrate shape:** `signals` **`UNIQUE (ticker, date, signal, signal_type)`** + **`alerted_at TEXT`** (migration `016`); `positions` with trailing-stop + **`pnl_pct`** / **`exit_reason`** (incl. **`REBALANCE_DROP`** via `006`); **`corporate_actions`** (`008`); **`backtest_runs.strategy`**, **`window_label`**, **`locked`** (`007`, `009`); `backtest_trades` with **`REBALANCE_DROP`** in exit_reason CHECK (`015`).
- **Dashboard backtest reference:** latest **`MOMENTUM` + `locked = 1`** run (**id=82**, 2023–2025 bull window; PR-6 ceremony 2026-06-04 — `REBALANCE_DROP` mapping fix). Migration `009` locked ids 73–74; id=82 supersedes via ceremony. Unlocked research runs do not displace the pin.
- **Split adjustment (PR-4):** `cue adjust-splits` records splits in **`corporate_actions`**, adjusts OPEN **`positions` / `signals`**, and retroactively adjusts **`daily_prices`** for `date < ex_date` (OHLC ÷ `factor`, volume × `factor`) so momentum/backtest inputs stay continuous. One-shot **`cue backfill-splits`** replays existing ledger rows (oldest `ex_date` first); idempotent via **`pipeline_state`** key `backfill_split_applied:{ticker}:{ex_date}`.
- **Live `positions` exit mapping** (`mapLiveExitReason` / `006`): `TRAILING_STOP → TRAILING_STOP`; `MAX_HOLD → TIME_EXIT`; **`REBALANCE_DROP → REBALANCE_DROP`**; `FORCED_CLOSE → MANUAL`.
- **Live Performance dashboard:** `getLivePerformanceSummary` / `getLivePerformanceByConfidence` exclude **`MANUAL`** and **`REBALANCE_DROP`**; backtest comparison metrics come from **`getMomentumBacktestSummary`** (`formatBacktestRef` in `template.ts`), not hardcoded constants.
- **`backtest_trades` exit mapping** (simulator only, `closedTradeToDbExit` in `runner.ts`): `gapOrStop → TRAILING_STOP`; `maxHoldDays → TIME_EXIT`; `standardTakeProfit → MANUAL`; **`standardTrendBreak → REBALANCE_DROP`** (fixed in PR-6 migration `015`). `INITIAL_STOP` reserved in CHECK but not emitted by the current runner.
- **T-1 staleness flag:** `massive-price-ingestor.ts` writes `pipeline_state.last_ingest_was_stale = "1"` when the resolved session date was already in `daily_prices`. `healthcheck.ts` check `ingest_staleness` reads this flag and returns FAIL if set.
- **Pipeline step exit codes:** `runPipelineWithSteps` persists `step:{name}:last_exit_code` / `step:{name}:last_run_at` after every registry step. `healthcheck.ts` **`checkPipelineStepState`** FAILs when critical steps (`ingest`+`screen` on Sunday, `ingest`+`execute-stops` Tue–Sat) last exited non-zero; absent keys warn only.
- **SQLite pragmas:** `applySqlitePragmas()` in `db/provider.ts` sets WAL, `busy_timeout=5000`, `synchronous=NORMAL`, `cache_size=-64000`, `mmap_size=268435456`, `temp_store=MEMORY` on every read-write connection. `openCueDbReadonly()` applies `busy_timeout=5000` only.
- **`fundamentals_cache`:** disk cache first, then best-effort SQLite upserts keyed by (`ticker`, `as_of_date`).
- **Next migration ID:** **`017`**.
- **Reference:** **`.cursor/rules/cue-db-schema.md`** (repo agent summary tied to applied migrations).

---

## 8. Deployment

- **VM:** Oracle Cloud (e.g. `VM.Standard.E2.1.Micro`, Ubuntu) — same *class* of host as arch doc; **independent** PM2 process from Market Pulse.
- **Repo layout on server:** e.g. `/opt/cue`; secrets **`chmod 600`** `.env`; PM2 **`env_file`**.
- **Processes:** `deploy/ecosystem.config.cjs` defines two apps:
  - **`cue`** — long-lived scheduler (`src/cli.ts pipeline` or prefer **`src/cli.ts schedule`**); logs **`logs/pm2-cue.log`** (merged out/error).
  - **`cue-healthcheck`** — cron-only (`src/cli.ts healthcheck`, **`autorestart: false`**). Default cron **`0 11 * * 0,2,3,4,5,6`** (UTC) ≈ **~07:00 EDT** on Sun/Tue–Sat — fires after the 06:00 ET pipeline window. Use **`0 7 * * 0,2,3,4,5,6`** if host clock is **`America/New_York`** (PM2 cron uses system timezone). PM2 7+ rejects `0,2-6`; use `0,2,3,4,5,6`.
- **Logs:** scheduler → `logs/pm2-cue.log`; healthcheck → `logs/healthcheck-out.log` / `logs/healthcheck-error.log`.

---

## 9. Guardrails

Hard rules: **`.cursor/rules/cue-guardrails.md`** (*v1.1+ — enforcement paths match this repo*). Topics: QQQ SMA200 gate, momentum formula lock, ATR golden rule, pipeline criticality, **scheduler `isRunning` + `LOCK_PATH` + `pipeline_state`**, LLM Zod validation, ingest DB currency guard, Telegram `--mode` behaviour.

## 10. Environment variables

See **`src/config/index.ts`** for the full **`zod`** schema. Highlights:

| Variable | Role |
|---|---|
| `POLYGON_API_KEY` | Massive REST |
| `DB_PATH`, `LOCK_PATH`, `CACHE_DIR`, `UNIVERSE` | Storage / universe label / scheduler PID lock |
| `LLM_PROVIDER`, provider keys, `VERTEX_*`, `LLM_MAX_TOKENS` | LLM |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Alerts |
| `LOG_LEVEL` | Winston |
| Position / RSI / ATR params | `MAX_POSITIONS`, `POSITION_SIZE_USD`, `PORTFOLIO_VALUE_USD`, `STOP_LOSS_PCT`, `MAX_HOLD_DAYS`, `SMA_PERIOD`, etc. |

---

## 11. Phase history

| Phase | Deliverable | Status |
|---|---|---|
| 1 — Core engine | 12-1 ranker + ATR + backtest gate | ✅ LOCKED |
| 2 — AI & alerts | LLM enrich + Telegram | ✅ LOCKED |
| 3 — Dashboard + pipeline | HTML dashboard + **`daily-workflow`** registry + **`cue brief`** | ✅ Complete |
| 3+ — Ops hardening (this repo) | **`scheduler.ts`** ET window, Fri vs Mon–Thu routes, **`isRunning`**, **`LOCK_PATH`**, **`cue-timezone`**, **`llm-smoke`**, README / rules | ✅ Shipped here |
| 4 — Infrastructure + universe | Grouped fetcher, lockfile, stop dashboard, full universe, fundamentals wiring, Quality-GARP research (closed) | ✅ Complete |
| 5 — Alert enrichment + intra-week visibility | Enriched BUY Telegram message, `brief --mode stop` Daily Pulse, S6 writer verification | ✅ Complete |
| 6 — Live performance instrumentation | Stop proximity warning, ATR position sizer, live expectancy dashboard, positions `pnl_pct` + `exit_reason` (migration 005) | ✅ Complete |
| 7 — Bug fixes + capital safety + instrumentation | `REBALANCE_DROP` exit reason; backtest `strategy` discriminator; corporate actions split adjuster; bear backtest extension (Sharpe 0.956 documented); healthcheck cron; watchlist bench #4–#8; **Saturday rebalance** cadence fix | ✅ Complete |
| 8 — Scheduler reliability + stop audit | Scheduler idempotency (`pipeline_state`); trailing-stop audit log (`stop_movements`); parallel LLM enrichment; P7-G VIX research (falsified) | ✅ Complete |
| 9 — Stop-replay correctness + ingestor modernisation | `replayExitReason` stale-stop fix; ratchet `nextHigh` over all unevaluated bars; SELL Telegram alerts; same-day artefact filter; T+0-first ingestor + auto-backfill; scheduler 06:00 ET window | ✅ Complete |
| **9b — Arch-review gap closure (June 2026)** | PR-4: corporate actions + split adjust; PR-5: Yahoo 15s timeout, T-1 staleness flag, sizer fallback 5% cap; PR-6: `REBALANCE_DROP` in `backtest_trades` (migration `015`) + backtest gate id=82; PR-7: `alerted_at` audit column (migration `016`); PR-9: SQLite WAL + pragmas; PR-10: unified `PIPELINE_STEPS` registry, SELL `signal_type: "MOMENTUM"`, pulse suppression, `verifyMigrations`, reason emoji labels | ✅ Complete |


---

## 12. Known issues & tracker

| ID | Severity           | Issue | Status                                                                                                                                            |
|---|--------------------|---|---------------------------------------------------------------------------------------------------------------------------------------------------|
| S4 | FIXED              | Massive **free-tier / call count** | ✅ **RESOLVED:** `cue ingest` uses **grouped daily** (one REST call / run); optional multi-day backfill / vendor paging remains separate future work |
| S5 | FIXED              | `rankedUniverse=0` log on stop runs (misleading) | ✅ **RESOLVED:** stop path no longer emits misleading `info`-level ranking noise |
| S6 | FIXED              | `backtest_trades` writer | ✅ **CONFIRMED LIVE:** `persistBacktestArtifacts()` captures inserted run id and persists per-trade rows when `backtest_trades` exists |
| — | DATA               | Massive EOD **lag** 1–2d | Accepted                                                                                                                                          |
| — | DATA               | `fundamentals_cache` only reflects run dates | Accepted — table grows organically via `cue enrich-fundamentals`; historical backfill deferred |
| — | FIXED (repo)       | `--force-rebalance` not reaching screen | ✅ `forwardArgs` / `pnpmRunArgs`                                                                                                                   |
| — | FIXED (repo)       | Ingest cache used request time not **DB** max date | ✅ `MAX(date)` guard                                                                                                                               |
| — | FIXED (repo)       | BUY Telegram noise on stop | ✅ `--mode stop` + dispatcher                                                                                                                      |
| — | FIXED (repo)       | No intra-week Telegram visibility when sells=0 | ✅ stop path now sends Daily Pulse on every `cue brief --mode stop` run |
| — | FIXED (Phase 6)    | positions missing `pnl_pct` / `exit_reason` — live trades not comparable to `backtest_trades` | ✅ Migration `005` + `closePosition()` writer updated |
| — | FIXED (Phase 6)    | No live expectancy visibility on dashboard | ✅ Live Performance section added |
| — | FIXED (arch S3)    | Scheduler overlap | ✅ **`isRunning`** + **`LOCK_PATH`** in `scheduler.ts`                                                                                             |
| — | FIXED (arch S1/S2) | Positions columns + signals composite uniqueness | ✅ **`003_positions_signals_upgrade.sql`** (after `001` baseline)                                                                                  |
| — | BACKTEST | Sharpe 0.956 on 2022–2025 window misses >1.0 gate | **Closed (P7-G falsified)** — not high-VIX entry noise; VIX overlay inactive on rebalance Fridays; no param change |
| — | BACKTEST | Survivorship bias in pre-2024 NDX100 constituent history | Accepted caveat |
| — | FIXED (Phase 9) | `replayExitReason` seeded from `initialAtrStop` → false TRAILING_STOP; positions never ratcheted | ✅ Seeds from `currentStop`; loop anchored to `lastEvaluatedDate` |
| — | FIXED (Phase 9) | Ratchet `nextHigh` used only `asOf` close → missed peaks in gaps | ✅ Scans all bars from `lastEvaluatedDate` through `asOf` |
| — | FIXED (Phase 9) | SELL signals not sent to Telegram | ✅ `sendSellAlerts` on both modes before BUY/pulse |
| — | FIXED (Phase 9) | Same-day artefact positions inflated live-perf stats | ✅ `exit_date > entry_date` filter in live-perf + SELL alert queries |
| OPS | FIXED (Phase 9b) | Healthcheck cron should fire after pipeline window | ✅ `deploy/ecosystem.config.cjs` updated to `0 11 * * 0,2,3,4,5,6` UTC |

---

## 13. Phase 8 — complete (May 2026)

| Task | Status |
|------|--------|
| **P8-A** Scheduler idempotency (`010_pipeline_state`) | ✅ Merged |
| **P8-B** Stop eval + healthcheck hardening | ✅ Merged |
| **P8-C** Parallel LLM enrichment | ✅ Merged |
| **P7-H** Trailing stop audit log (`011_position_audit`) | ✅ Merged |
| **P7-F** Daily position thesis refresh | ✅ Gated stub (`cue refresh-thesis`); body pending 15+ genuine closed trades |
| **P7-G** VIX secondary regime (research) | ✅ **Falsified** — `VIX_MOMENTUM_RESEARCH` runs 81–84; gate inactive; Sharpe 0.956 unchanged |

**P7-G conclusion:** VIX ≤ {25,28,30,35} stacked on QQQ SMA200 did not change the trade set on 2022–2025 rebalance Fridays. Sharpe miss is not attributable to high-VIX entry noise. Research archived in `src/backtest/strategies/vix-momentum.ts`; no prod code.

**Deferred (no gate dependency):** `fundamentals_cache` backfill, systemd unit, Winston file transport. **Active pending:** P7-F refresh body (self-gates on production ledger).

Full record: **`spec/cue-phase8-complete.md`**.

---

## 14b. Phase 9 — complete (June 2026)

| Task | Status |
|------|--------|
| **P9-A** `replayExitReason` stale-stop seed fix | ✅ `currentStop` + `lastEvaluatedDate` anchor |
| **P9-B** Ratchet `nextHigh` over all unevaluated bars | ✅ `slice.filter(b => b.date > lastEvaluatedDate).reduce(max)` |
| **P9-C** SELL signal Telegram alerts | ✅ Both modes; exit reason emoji + P&L; `alerted=1` after send |
| **P9-D** Live perf same-day artefact filter | ✅ `exit_date > entry_date` in live-perf + SELL alert queries |
| **P9-E** Dashboard SELL row + full rationale display | ✅ Exit reason + P&L in SELL row; full text rationale cell |
| **P9-F** Scheduler 06:00–06:10 ET + T-1 next-morning ingestor + auto-backfill | ✅ Shipped |

## 14c. Phase 9b — arch-review gap closure (June 2026)

| Task | PR | Status |
|------|----|--------|
| Corporate actions + split adjust | PR-4 | ✅ `cue adjust-splits`, `cue backfill-splits`, migration `008` |
| Yahoo chart 15s timeout | PR-5 | ✅ `chartWithTimeout` in `corporate-actions.ts` |
| T-1 staleness pipeline_state flag + healthcheck | PR-5 | ✅ `last_ingest_was_stale` in `massive-price-ingestor.ts`; `ingest_staleness` check in `healthcheck.ts` |
| ATR sizer 5% book fallback cap | PR-5 | ✅ `deriveBuyAlertShares` in `telegram-dispatcher.ts` |
| `REBALANCE_DROP` in `backtest_trades` CHECK | PR-6 | ✅ Migration `015`; `closedTradeToDbExit` maps `standardTrendBreak → REBALANCE_DROP` |
| Backtest gate ceremony → id=82 | PR-6 | ✅ Locked 2026-06-04; `spec/cue-handoff.md` §2.2 |
| `signals.alerted_at` audit column | PR-7 | ✅ Migration `016`; `markSignalAlerted` / `markWatchlistSignalsAlerted` |
| SQLite WAL + performance pragmas | PR-9 | ✅ `applySqlitePragmas()` in `db/provider.ts` |
| Unified `PIPELINE_STEPS` registry + `stepsForMode()` | PR-10 | ✅ `daily-workflow.ts`; scheduler uses `stepsForMode()` |
| SELL `signalType: "MOMENTUM"` explicit | PR-10 | ✅ `momentum-screener.ts` |
| Daily Pulse suppression when 0 open + 0 sells | PR-10 | ✅ `sendDailyPulse(db, sellCount)` |
| Migration pre-flight `verifyMigrations` | PR-10 | ✅ `HEAD_MIGRATION = "016_signals_alerted_at"` in `scheduler.ts` |
| Exit reason emoji labels (🔴 🔄 ⏱ ✋) | PR-10 | ✅ `reasonLabels` in `formatTelegramSellAlert` |
| `openCueDbReadonly` busy_timeout | PR-10 | ✅ Applied in `db/provider.ts` |
| Healthcheck cron after 06:00 ET window | PR-10 | ✅ `deploy/ecosystem.config.cjs` `0 11 * * 0,2,3,4,5,6` UTC |

Full record: **`spec/cue-phase9-complete.md`**.

---

| Document | Role |
|---|---|
| `.cursor/rules/cue-sou.md` | Living engineering spec (this file) |
| `.cursor/rules/cue-db-schema.md` | Schema summary tied to **applied** migrations (`001`–`016`) |
| `.cursor/rules/cue-guardrails.md` | Hard constraints |
| `spec/cue-reference.md` | Compressed living spec (Phase 9 current) |
| `spec/cue-handoff.md` | Locked architectural decisions + research archive |
| `README.md` | Operator-facing commands + quickstart |

---

## 15. Phase 4 Historical Ledger & Post-Mortem (May 2026)

### 15.1 Architectural Modifications & Infrastructure Upgrades
Phase 4 successfully migrated Cue from a localized staging sandbox to an enterprise-grade, full-scale production environment on the Oracle Cloud VM instance. The following system-level changes are locked into the codebase:

* **Concurrency Lock Hardening (§4.4 / §12):** Upgraded the ephemeral in-memory state flag to an atomic, PID-backed persistent lockfile layer (`LOCK_PATH`, default `./db/cue.lock`). Stale locks caused by unexpected PM2 or VM reboots are detected using process liveness signals (`process.kill(pid, 0)`) and automatically cleared.
* **Grouped Massive Ingestor Optimization (§6.1 / S4):** Completely eliminated the sequential 100-query per-ticker REST request loop. Ingestion now utilizes Massive's bulk endpoint (`/v2/aggs/grouped/locale/us/market/stocks/`) to aggregate the market cross-section in exactly one network call, safeguarding the database currency guard (`MAX(date)`) and enforcing an 80% quorum rule before executing transactional writes.
* **Full Universe Expansion (§3.1):** Expanded the execution matrix to dynamically parse all 100 active components tracked in `data/universe/nasdaq100.json` alongside `QQQ` for index regime filtering.
* **Dashboard Trailing Stop Instrumentation (§4.4):** Upgraded the static HTML generation script to read and display `highest_close_since_entry` and `current_stop_loss` metrics directly from active portfolio ledger positions. Added structural badge labeling to dynamically distinguish between the `Base (4.0x ATR)` and `Tight (1.5x ATR)` trailing stop sub-regimes.
* **Cosmetic Log Sanitization (Issue S5):** Gated cross-sectional array tracking traces (`rankedUniverse=0`) to emit exclusively on `rebalance` runs. Mon-Thu `stop` paths now route telemetry quietly through the `debug` log tier with an informative string.

### 15.2 Quality-GARP Strategy Evaluation (Task 4.6 Research Archive)
Per strategy constraints, a secondary research module was built to evaluate a Growth At A Reasonable Price (GARP) alpha model. The strategy was restricted to an isolated backtester harness, logging exclusively to the `backtest_trades` audit schema without writing to live execution states.

#### Mathematical Formula Chain
* **Quality Filtering Constraints:** $$\text{Return on Equity (ROE)} \ge 15.0\%$$
  $$\text{Debt-to-Equity (D/E)} \le 1.5$$
* **Pricing Multiplier Evaluation ($PEG$):** $$PEG = \frac{PE_{ttm}}{\Delta EPS_{3Y} \times 100}$$
  $$\text{where } \Delta EPS_{3Y} = \left(\frac{EPS_{now}}{EPS_{3Y\_ago}}\right)^{\frac{1}{3}} - 1$$
* **Ranking Constraint:** Sort survivors ascending by $PEG$, entry restricted to top 3 lowest positive records.

#### Backtest Iteration Results (Window: 2023-01-01 → 2025-12-31)

| Metric | Core Momentum (Locked) | GARP v1 (Rotational Model) | GARP v2 (Technical Exit Model) | Gate Threshold |
| :--- | :--- | :--- | :--- | :--- |
| **CAGR** | **21.39%** *(id=74 archival)* | 1.11% | 2.60% | N/A |
| **Max Drawdown** | **11.54%** *(id=74)* | 6.56% | 8.49% | < 20.0% |
| **Win Rate** | **52.20%** | 44.44% | 53.33% | N/A |
| **Sharpe Ratio** | **1.162** *(id=74)* | -0.778 | **-0.188** | **> 0.8** |
| **Expectancy** | **+4.78%** *(id=74)* | +2.329% | +1.112% | > 0.0% |
| **Total Trades** | **78** | 9 | 45 | N/A |
| **Gate Verdict** | **LOCKED / PROD** | **BLOCKED** | **BLOCKED** | N/A |

*Current production momentum lock: **id=82** (§3.3 — 102 trades, PR-6 ceremony 2026-06-04). Table above is the original Phase 4 GARP comparison snapshot (id=74, 78 trades).*

#### Factor Breakdown & Diagnostic Post-Mortem
The strategy underperformed due to anti-momentum factor selection. The valuation filters systematically excluded premium megacap technology assets that drove index returns during the 2023–2025 market cycle. Stripping out rotational rebalance liquidations (`REBALANCE_DROP`) normalized trade frequency and improved win rates, but the final Sharpe ratio ($-0.188$) fell drastically short of the production clearance floor ($>0.8$).

**Quality-GARP is permanently archived as an unvalidated alpha factor; no production code will be adjusted to accommodate it.**

----

*End of project-spec — prefer `src/db/migrations` and `src/agents/*.ts` over prose when in doubt.*


