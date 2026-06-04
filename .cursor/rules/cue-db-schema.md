# Cue — SQLite schema reference

**Database file:** configurable via `DB_PATH` (default `./db/cue.db`).  
**Source of truth for DDL:** numbered files in `src/db/migrations/*.sql`, applied in lexicographic order and recorded in **`_migrations`** (`id` = filename without `.sql`).

This document summarizes tables, important columns, and how they relate to pipeline stages. For exact `CREATE TABLE` syntax, read the migration files.

---

## Migration ledger (applied order)

| `id` (stem) | Summary |
|-------------|---------|
| `001_initial_schema` | Core tables: `daily_prices`, `signals`, `enrichments`, `positions`, `backtest_runs` |
| `002_create_fundamental_cache` | `fundamentals_cache` |
| `003_positions_signals_upgrade` | `positions` trailing-stop columns; `signals` unique → `(ticker, date, signal, signal_type)` |
| `004_create_backtest_trades` | `backtest_trades` + indexes |
| `005_positions_pnl_exit_reason` | `positions.pnl_pct`, `positions.exit_reason` (CHECK without `REBALANCE_DROP` yet) |
| `006_rebalance_drop_exit_reason` | Rebuild `positions`; CHECK adds **`REBALANCE_DROP`**; backfill flat same-day rotation exits |
| `007_backtest_runs_strategy` | `backtest_runs.strategy`; backfill by id: **73, 74** → `MOMENTUM`; **75–79** → `GARP_RESEARCH`; remaining rows → `SWEEP` |
| `008_corporate_actions` | `corporate_actions` (splits / reverse splits) |
| `009_backtest_runs_window_label` | `backtest_runs.window_label`, `backtest_runs.locked`; backfill locks bull-window runs **73, 74** (`2023-2025 (bull)`), labels extended run **80** (`2022-2025 (extended)`, unlocked) |
| `010_pipeline_state` | `pipeline_state` — scheduler idempotency key/value store |
| `011_position_audit` | `stop_movements` (trailing-stop audit log), `position_notes` (thesis snapshots); FK → `positions.id` **without** `ON DELETE CASCADE` (immutable ledger) |
| `012_perf_indexes` | Additive query indexes: signals, enrichments, positions, daily_prices, stop_movements |
| `013_enrichment_status` | ALTER TABLE enrichments ADD COLUMN status (OK/LLM_FAIL/TIMEOUT/SCHEMA_FAIL/YAHOO_FAIL); backfills existing rows to 'OK' |
| `014_enrichments_signal_id_unique` | `enrichments.signal_id` UNIQUE |
| `015_backtest_rebalance_drop` | Rebuild `backtest_trades`; CHECK adds **`REBALANCE_DROP`**; re-index ticker + run_id |
| `016_signals_alerted_at` | ALTER TABLE `signals` ADD COLUMN `alerted_at` TEXT; NULL until alert fires; written by `markSignalAlerted` |

**Next migration:** `017`

There is **no CHECK** on `signals.signal` — values are enforced in application types (`BUY`, `SELL`, `HOLD`, `WATCHLIST`).

**Post-migrate data note (`009` + ceremonies):** `locked = 1` is set by migration backfill (ids **73, 74**, later cleared) or an explicit gate ceremony. Current dashboard pin: **id=82** (2026-06-04, supersedes 81 — `spec/cue-handoff.txt` §2.2). New `pnpm run backtest` rows default `locked = 0`. `getMomentumBacktestSummary` selects latest **`strategy = 'MOMENTUM' AND locked = 1`**, not newest by `run_date`.

---

## Ledger

### `_migrations`

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT PK | Migration stem, e.g. `001_initial_schema` |
| `applied_at` | TEXT | Timestamp when applied |

Created by `src/db/migrate.ts` (runner in `migrations/migrate.ts`) if missing. Not modified by app business logic.

---

## Market data

### `daily_prices`

End-of-day OHLCV bars (Massive.com ingest).

| Column | Notes |
|--------|--------|
| `ticker`, `date` | **UNIQUE** composite; `date` is ISO `YYYY-MM-DD` |
| `open`, `high`, `low`, `close` | REAL |
| `volume` | INTEGER |
| `created_at` | Audit |

**Written by:** `cue ingest` (`massive-price-ingestor.ts`); universe list from `data/universe/${UNIVERSE}.json` (see `src/universe/load-universe.ts`, `_meta.json`).

**Split-adjusted (PR-4):** pre–ex-date rows updated by `adjustDailyPricesBeforeExDate()` when `cue adjust-splits` or `cue backfill-splits` applies a `corporate_actions` event (OHLC ÷ `factor`, volume × `factor`).

### `corporate_actions`

Split / reverse-split events for price adjustment (`008_corporate_actions`).

| Column | Notes |
|--------|--------|
| `id` | INTEGER PK AUTOINCREMENT |
| `ticker`, `ex_date`, `type` | **UNIQUE** composite; `type` CHECK IN (`split`, `reverse_split`) |
| `ex_date` | ISO `YYYY-MM-DD` |
| `factor` | REAL — divisor (e.g. `2.0` = 2:1 forward split) |
| `source` | TEXT, default `yahoo` |
| `applied_at` | TEXT, default `CURRENT_TIMESTAMP` |

**Written by:** `cue adjust-splits` (`src/ingestors/corporate-actions.ts`).

**Consumed by:** `adjustDailyPricesBeforeExDate()` (live `applySplit` transaction) and **`cue backfill-splits`** (`scripts/backfill_historical_split_adjustments.ts`) for historical replay.

**Pipeline position:** after **ingest**, before **screen** / **execute-stops** (`critical: false`).

**Yahoo API:** split events via **`yahoo-finance2` `chart()`** (not `src/llm/yahooContext.ts`, which uses `search` / `quoteSummary` for LLM enrichment only).

---

## Signals & AI output

### `signals`

Momentum screen outputs: actionable **BUY** / **SELL**, plus rebalance-only **WATCHLIST** bench rows (ranks just below the top-N book).

| Column | Notes |
|--------|--------|
| `id` | INTEGER PK AUTOINCREMENT |
| `ticker`, `date`, `signal`, `signal_type` | **UNIQUE** composite (`003`) |
| `signal` | `BUY` \| `SELL` \| `HOLD` \| `WATCHLIST` — plain TEXT, no DB enum. **`WATCHLIST`** = rebalance-only rank context rows (ranks `topN+1`…`topN+depth`); **no** position entry; screener **Saturday rebalance** path only |
| `signal_type` | Strategy lane; default **`MOMENTUM`** |
| `price` | REAL at signal |
| `alerted` | 0/1 — Telegram / brief idempotency (BUY alerts and watchlist bench) |
| `alerted_at` | TEXT — ISO timestamp written when `alerted=1` is set; NULL if not yet alerted |
| `momentum_rank`, `universe_ranked_count`, `momentum_12_1_return` | Cross-sectional rank context (required for BUY and WATCHLIST at insert) |
| `atr14`, `initial_atr_stop` | Stop ladder inputs; `initial_atr_stop` set on BUY; optional on WATCHLIST |

**Written by:** `cue screen` (`momentum-screener.ts`). **WATCHLIST** rows: **Saturday rebalance** path only, ranks `topN+1` … `topN+WATCHLIST_BENCH_DEPTH` (default depth 5 → ranks 4–8 when `topN=3`). No `positions` row. `WATCHLIST_BENCH_DEPTH=0` disables WATCHLIST writes and bench Telegram.

### `enrichments`

One row per enriched **`BUY` or `WATCHLIST`** `signal_id` (LLM + Yahoo headlines snapshot).

| Column | Notes |
|--------|--------|
| `signal_id` | FK → `signals.id` **ON DELETE CASCADE** |
| `status` | TEXT NOT NULL DEFAULT 'OK' CHECK IN (`OK`, `LLM_FAIL`, `TIMEOUT`, `SCHEMA_FAIL`, `YAHOO_FAIL`) — enrichment pipeline result; existing rows backfilled to OK via migration 013 |
| `sentiment`, `rationale`, `confidence` | LLM output (Zod-validated in app) |
| `earnings_flag`, `earnings_date` | Proximity / calendar |
| `sector`, `sector_trend`, `headlines` | Context persisted for briefing |

**Written by:** `cue enrich` (`thesis-generator` + `llm/enricher.ts`). Watchlist enrichment is fail-open per ticker (warnings only).

---

## Portfolio / execution

### `positions`

Open and closed book from **BUY** signals only (not WATCHLIST).

| Column | Notes |
|--------|--------|
| `signal_id` | FK → `signals.id` **ON DELETE CASCADE** |
| `entry_date`, `entry_price` | ISO date / REAL |
| `status` | `OPEN` \| `CLOSED` (app-defined strings) |
| `exit_date`, `exit_price` | Set on close |
| `pnl_pct` | REAL — `ROUND((exit - entry) / entry * 100, 4)` at close; NULL if invalid exit |
| `exit_reason` | TEXT CHECK IN (`TRAILING_STOP`, `INITIAL_STOP`, `TIME_EXIT`, `MANUAL`, **`REBALANCE_DROP`**) — see `006` |
| `highest_close_since_entry`, `current_stop_loss` | Trailing stop machinery (`003` backfill from signal stop) |

**Written by:** `momentum-screener.ts` (`cue screen`, `cue execute-stops`).

**Live exit mapping:** `TRAILING_STOP` → `TRAILING_STOP`; `MAX_HOLD` → `TIME_EXIT`; `REBALANCE_DROP` → `REBALANCE_DROP`; `FORCED_CLOSE` → `MANUAL`.

**Dashboard Live Performance** (`src/briefing/queries.ts`): closed-position aggregates **exclude** `exit_reason IN ('MANUAL', 'REBALANCE_DROP')` so rotation drops do not appear as strategy P&amp;L. Zero-state copy uses **`formatBacktestRef`** from the locked momentum backtest row (see `backtest_runs` below).

### `stop_movements`

Append-only audit log for every trailing-stop ladder mutation during **`cue execute-stops`** (`011_position_audit`).

| Column | Notes |
|--------|--------|
| `position_id` | FK → `positions.id` — **no** `ON DELETE CASCADE` (immutable ledger) |
| `as_of_date` | ISO `YYYY-MM-DD` — session date of evaluation |
| `previous_stop`, `new_stop` | `current_stop_loss` before / after |
| `previous_high`, `new_high` | `highest_close_since_entry` before / after |
| `stop_regime` | CHECK IN (`BASE`, `TIGHT`) — 4.0× vs 1.5× ATR multiplier |
| `close_price`, `atr14` | Bar close and ATR(14) used for evaluation |
| `recorded_at` | Default `CURRENT_TIMESTAMP` |

**UNIQUE** `(position_id, as_of_date)` — idempotent `INSERT OR IGNORE`. Rows written only when stop or high-water mark actually changes (no no-op evaluations).

**Written by:** `insertStopMovement()` in `src/db/queries.ts`; called from `momentum-screener.ts` stop-mode path.

### `position_notes`

Operator or LLM thesis snapshots attached to a position (`011_position_audit`).

| Column | Notes |
|--------|--------|
| `position_id` | FK → `positions.id` — **no** `ON DELETE CASCADE` |
| `note_type` | CHECK IN (`ENTRY_THESIS`, `REFRESH_THESIS`, `OPERATOR_NOTE`) |
| `content` | LLM rationale or operator freetext |
| `as_of_date` | ISO `YYYY-MM-DD` |
| `recorded_at` | Default `CURRENT_TIMESTAMP` |

**Written by:** manual inserts today; future **`cue refresh-thesis`** (P7-F, gated on 15+ genuine closed trades).

### `pipeline_state`

Scheduler idempotency key/value store (`010_pipeline_state`).

| Column | Notes |
|--------|--------|
| `key` | TEXT PK |
| `value` | TEXT |
| `updated_at` | Default `CURRENT_TIMESTAMP` |

**Written by:** `setPipelineState()` / read by `getPipelineState()` in `src/db/queries.ts`.

**Keys in use:**
| Key pattern | Purpose |
|-------------|---------|
| `last_successful_run_date` | Scheduler idempotency (ET `YYYY-MM-DD`) |
| `backfill_split_applied:{ticker}:{ex_date}` | Split replay idempotency for `daily_prices` (`cue backfill-splits` + live `applySplit`) |

---

## Fundamentals (Phase 4+)

### `fundamentals_cache`

| Column | Notes |
|--------|--------|
| `ticker`, `as_of_date` | **UNIQUE** composite |
| `payload_json` | TEXT — serialized bundle for briefing / future prompts |
| `fetched_at` | Default `CURRENT_TIMESTAMP` |

**Written by:** `cue enrich-fundamentals` (disk cache under `CACHE_DIR`, then best-effort SQLite upsert).

---

## Backtesting

### `backtest_runs`

Aggregated metrics for a labeled historical run (`src/backtest/runner.ts`).

| Column | Notes |
|--------|--------|
| `run_date`, `from_date`, `to_date` | ISO strings |
| `cagr`, `max_drawdown`, `win_rate`, `sharpe_ratio`, `total_trades`, `benchmark_cagr`, `expectancy` | REAL metrics |
| `strategy` | TEXT — e.g. `MOMENTUM`, `GARP_RESEARCH`, `VIX_MOMENTUM_RESEARCH` (P7-G research archive), `SWEEP` (`007`) |
| `window_label` | TEXT — human label for dashboard (`009`) |
| `locked` | INTEGER **NOT NULL** default **0** — `1` pins a run as the dashboard reference (`009` backfill: 73–74; ceremony: **id=82** as of 2026-06-04) |

**Read by:** `getMomentumBacktestSummary()` in `src/briefing/queries.ts` — `WHERE strategy = 'MOMENTUM' AND locked = 1 ORDER BY run_date DESC LIMIT 1` (current pin: **id=82**).

**Written by:** `insertBacktestRun()` / `persistBacktestArtifacts()` in `src/backtest/runner.ts` (optional `windowLabel`, `locked`; defaults unlocked).

### `backtest_trades`

Granular trades per backtest run (`004`).

| Column | Notes |
|--------|--------|
| `run_id` | FK → `backtest_runs.id` |
| `ticker`, `entry_date`, `entry_price`, `exit_date`, `exit_price`, `pnl_pct` | Trade fields |
| `exit_reason` | CHECK IN (`TRAILING_STOP`, `INITIAL_STOP`, `TIME_EXIT`, `MANUAL`, **`REBALANCE_DROP`**) — see `015` |

**Indexes:** `idx_bt_trades_ticker`, `idx_bt_trades_run`.

---

## Indexes

Migrations **001**–**003**, **005**–**009** rely on PK/UNIQUE only (no extra indexes on `corporate_actions` at current scale). **`004`** adds `idx_bt_trades_ticker`, `idx_bt_trades_run`. Consider new migrations for hot paths (e.g. `signals(date, signal)`) if profiling warrants.

---

## Post-pipeline health (no table)

**`cue healthcheck`** (`src/agents/healthcheck.ts`) — PM2 cron at **~21:00 ET** Mon–Fri (after the 20:00 ET pipeline window), **~10:00 ET** Saturday. Checks:

1. **`daily_prices` currency** — `MAX(date)` vs `resolveLastETSession()`.
2. **Pipeline output** — Saturday: `signals` rows for today's ET date; Mon–Fri: OPEN positions and/or non-`REBALANCE_DROP` closes today.
3. **PM2 error log** — last 100 lines of `logs/pm2-cue.log`; FAIL on `error`-level lines in last 90 minutes.

Results sent via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

---

## ER-style relationships

```
signals 1──* enrichments   (BUY and WATCHLIST signal_ids)
signals 1──* positions     (BUY only)
positions 1──* stop_movements   (append-only; no CASCADE delete)
positions 1──* position_notes   (append-only; no CASCADE delete)
daily_prices (ticker, date)
corporate_actions (ticker, ex_date)
backtest_runs 1──* backtest_trades
pipeline_state (key → value)
```
