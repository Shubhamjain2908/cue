# Cue — SQLite schema reference

**Database file:** configurable via `DB_PATH` (default `./db/cue.db`).  
**Source of truth for DDL:** numbered files in `src/db/migrations/*.sql`, applied in lexicographic order and recorded in **`_migrations`** (`id` = filename without `.sql`).

This document summarizes tables, important columns, and how they relate to pipeline stages. For exact `CREATE TABLE` syntax, read the migration files.

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

---

## Signals & AI output

### `signals`

Momentum / regime screen outputs and BUY/SELL rows. BUY rows carry denormalized momentum fields for enrichment and alerts.

| Column | Notes |
|--------|--------|
| `ticker`, `date`, `signal`, `signal_type` | **UNIQUE** composite |
| `signal` | e.g. BUY / SELL semantics used by screener |
| `price` | REAL at signal |
| `alerted` | 0/1 — Telegram / brief idempotency |
| `momentum_rank`, `universe_ranked_count`, `momentum_12_1_return` | Cross-sectional rank context |
| `atr14`, `initial_atr_stop` | Stop ladder inputs |

**Written by:** `cue screen` (momentum-screener).

### `enrichments`

One row per enriched BUY `signal_id` (LLM + Yahoo headlines snapshot).

| Column | Notes |
|--------|--------|
| `signal_id` | FK → `signals.id` **ON DELETE CASCADE** |
| `sentiment`, `rationale`, `confidence` | LLM output (Zod-validated in app) |
| `earnings_flag`, `earnings_date` | Proximity / calendar |
| `sector`, `sector_trend`, `headlines` | Context persisted for briefing |

**Written by:** `cue enrich` (thesis-generator + `llm/enricher.ts`).

---

## Portfolio / execution

### `positions`

Open and closed book from BUY signals.

| Column | Notes |
|--------|--------|
| `signal_id` | FK → `signals.id` **ON DELETE CASCADE** |
| `entry_date`, `entry_price` | REAL / ISO date |
| `status` | App-defined status string (OPEN / closed variants) |
| `exit_date`, `exit_price` | Optional |
| `highest_close_since_entry`, `current_stop_loss` | Trailing stop machinery |

**Written by:** screener / `cue execute-stops` paths in `momentum-screener.ts` (see `queries.ts`).

---

## Fundamentals (Phase 4+)

### `fundamentals_cache`

| Column | Notes |
|--------|--------|
| `ticker`, `as_of_date` | **UNIQUE** composite |
| `payload_json` | TEXT — serialized bundle for briefing / future prompts |
| `fetched_at` | Default `CURRENT_TIMESTAMP` |

**Migration:** `002_create_fundamental_cache.sql`.  
**Current ingest:** `cue enrich-fundamentals` writes primarily to **disk cache** under `CACHE_DIR`; DB upserts from that CLI may be wired later (see `project-spec.md` follow-ups).

---

### Applied Schema Migrations Ledger

#### Migration 003: Portfolio Tracking Upgrade
* `positions` table expanded to include trailing stop metrics: `highest_close_since_entry` (REAL) and `current_stop_loss` (REAL).
* `signals` composite unique key constraint relaxed from `UNIQUE(ticker, date)` to `UNIQUE(ticker, date, signal, signal_type)` to safely allow cross-strategy segregation.

#### Migration 004: Historical Trade Ledger (`backtest_trades`)
Stores granular point-in-time historical execution strings generated during simulator sessions.
* `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
* `run_id` (TEXT NOT NULL REFERENCES backtest_runs(rowid))
* `ticker` (TEXT NOT NULL)
* `entry_date` (TEXT NOT NULL)
* `entry_price` (REAL NOT NULL)
* `exit_date` (TEXT)
* `exit_price` (REAL)
* `pnl_pct` (REAL)
* `exit_reason` (TEXT CHECK(exit_reason IN ('TRAILING_STOP','INITIAL_STOP','TIME_EXIT','MANUAL')))
* `created_at` (TEXT DEFAULT CURRENT_TIMESTAMP)

---

## Backtesting

### `backtest_runs`

Aggregated metrics for a labeled historical run (written by `src/backtest/runner.ts`).

| Column | Notes |
|--------|--------|
| `run_date`, `from_date`, `to_date` | ISO strings |
| `cagr`, `max_drawdown`, `win_rate`, `sharpe_ratio`, `total_trades`, `benchmark_cagr`, `expectancy` | REAL metrics |

---

## Indexes

Migrations **001** / **002** / **003** do not declare secondary indexes beyond PK/UNIQUE constraints. Add indexes in a new migration if query plans warrant them (e.g. `signals(date)`, `positions(status)`).

---

## ER-style relationships (text)

```
signals 1──* enrichments
signals 1──* positions
(daily_prices standalone by ticker+date)
```

---

## Regenerating this document from a live DB

If you need a raw SQL dump (e.g. after local experiments):

```bash
sqlite3 db/cue.db ".schema"
```

Prefer checking in **migration SQL** as the contract; ad-hoc `ALTER` in dev should be folded into a new numbered migration before sharing.
