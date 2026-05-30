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
| `007_backtest_runs_strategy` | `backtest_runs.strategy` |
| `008_corporate_actions` | `corporate_actions` (splits / reverse splits) |
| `009_backtest_runs_window_label` | `backtest_runs.window_label`, `backtest_runs.locked`; backfill locks bull-window runs **73, 74** (`2023-2025 (bull)`), labels extended run **80** (`2022-2025 (extended)`, unlocked) |

There is **no CHECK** on `signals.signal` — values are enforced in application types (`BUY`, `SELL`, `HOLD`, `WATCHLIST`).

**Post-migrate data note (`009`):** `locked = 1` is set only by migration backfill or a deliberate ceremony — new `pnpm run backtest` rows default to `locked = 0`. The dashboard backtest reference (`getMomentumBacktestSummary`) selects the latest **`strategy = 'MOMENTUM' AND locked = 1`** row, not the newest run by `run_date`.

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

### `corporate_actions`

Split / reverse-split events for price adjustment (`008_corporate_actions`).

| Column | Notes |
|--------|--------|
| `ticker`, `ex_date`, `type` | **UNIQUE** composite; `type` CHECK IN (`split`, `reverse_split`) |
| `factor` | REAL |
| `source` | TEXT, default `yahoo` |
| `applied_at` | Timestamp |

**Written by:** `cue adjust-splits` (corporate-actions ingestor).

---

## Signals & AI output

### `signals`

Momentum screen outputs: actionable **BUY** / **SELL**, plus rebalance-only **WATCHLIST** bench rows (ranks just below the top-N book).

| Column | Notes |
|--------|--------|
| `id` | INTEGER PK AUTOINCREMENT |
| `ticker`, `date`, `signal`, `signal_type` | **UNIQUE** composite (`003`) |
| `signal` | `BUY` \| `SELL` \| `HOLD` \| `WATCHLIST` — plain TEXT, no DB enum |
| `signal_type` | Strategy lane; default **`MOMENTUM`** |
| `price` | REAL at signal |
| `alerted` | 0/1 — Telegram / brief idempotency (BUY alerts and watchlist bench) |
| `momentum_rank`, `universe_ranked_count`, `momentum_12_1_return` | Cross-sectional rank context (required for BUY and WATCHLIST at insert) |
| `atr14`, `initial_atr_stop` | Stop ladder inputs; `initial_atr_stop` set on BUY; optional on WATCHLIST |

**Written by:** `cue screen` (`momentum-screener.ts`). **WATCHLIST** rows: Friday **rebalance** path only, ranks `topN+1` … `topN+WATCHLIST_BENCH_DEPTH` (default depth 5, ranks 4–8 when `topN=3`). No `positions` row. Depth `0` disables WATCHLIST writes and bench Telegram.

### `enrichments`

One row per enriched **`BUY` or `WATCHLIST`** `signal_id` (LLM + Yahoo headlines snapshot).

| Column | Notes |
|--------|--------|
| `signal_id` | FK → `signals.id` **ON DELETE CASCADE** |
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
| `strategy` | TEXT — e.g. `MOMENTUM`, `GARP_RESEARCH`, `SWEEP` (`007`) |
| `window_label` | TEXT — human label for dashboard (`009`) |
| `locked` | INTEGER **NOT NULL** default **0** — `1` pins a run as the dashboard reference (`009`) |

**Read by:** `getMomentumBacktestSummary()` in `src/briefing/queries.ts` — `WHERE strategy = 'MOMENTUM' AND locked = 1 ORDER BY run_date DESC LIMIT 1`.

**Written by:** `insertBacktestRun()` / `persistBacktestArtifacts()` in `src/backtest/runner.ts` (optional `windowLabel`, `locked`; defaults unlocked).

### `backtest_trades`

Granular trades per backtest run (`004`).

| Column | Notes |
|--------|--------|
| `run_id` | FK → `backtest_runs.id` |
| `ticker`, `entry_date`, `entry_price`, `exit_date`, `exit_price`, `pnl_pct` | Trade fields |
| `exit_reason` | CHECK IN (`TRAILING_STOP`, `INITIAL_STOP`, `TIME_EXIT`, `MANUAL`) — no `REBALANCE_DROP` on this table |

**Indexes:** `idx_bt_trades_ticker`, `idx_bt_trades_run`.

---

## Indexes

Migrations **001**–**003**, **005**–**009** rely on PK/UNIQUE only (no extra indexes on `corporate_actions` at current scale). **`004`** adds `idx_bt_trades_ticker`, `idx_bt_trades_run`. Consider new migrations for hot paths (e.g. `signals(date, signal)`) if profiling warrants.

---

## Post-pipeline health (no table)

**`cue healthcheck`** (`src/agents/healthcheck.ts`) verifies operational state after the **16:05–16:15 ET** scheduler window — typically via PM2 cron **`cue-healthcheck`** at **17:00 ET** (see `deploy/ecosystem.config.cjs`). Checks:

1. **`daily_prices` currency** — `MAX(date)` vs `resolveLastETSession()` (same session rule as `cue ingest`).
2. **Pipeline output** — Friday: `signals` rows for today’s ET date; Mon–Thu: OPEN positions and/or non-`REBALANCE_DROP` closes today.
3. **PM2 error log** — last 100 lines of `logs/pm2-cue.log`; FAIL on `error`-level lines in the last 90 minutes; **SKIP** if the log file is missing.

Results are sent via **`TELEGRAM_BOT_TOKEN`** / **`TELEGRAM_CHAT_ID`** (no separate alerts table).

---

## ER-style relationships (text)

```
signals 1──* enrichments   (BUY and WATCHLIST signal_ids)
signals 1──* positions     (BUY only)
daily_prices (ticker, date)
corporate_actions (ticker, ex_date)
backtest_runs 1──* backtest_trades
```

---

## Regenerating this document from a live DB

```bash
sqlite3 db/cue.db ".schema"
```

Prefer **migration SQL** as the contract; fold ad-hoc dev `ALTER` into a new numbered migration before sharing.
