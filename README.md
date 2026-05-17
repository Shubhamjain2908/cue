# Cue — Phase 1

US Equity Signal System scaffold: SQLite schema, pure strategy math (RSI / momentum / volume ratio), and unit tests. Fetcher, backtester, and live `screen` are not implemented in this increment.

## Requirements

- Node.js 22+
- [pnpm](https://pnpm.io/) 9
- A working C++ toolchain for native addons (macOS: Xcode Command Line Tools) so `better-sqlite3` can compile if no prebuilt binary exists for your Node/OS pair.

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Copy environment template and adjust values (all keys are required for config validation; use placeholders until you wire APIs):

   ```bash
   cp .env.example .env
   ```

3. Initialize the SQLite database (creates `daily_prices`, `signals`, `enrichments`, `backtest_runs`, `positions`):

   ```bash
   pnpm run db:init
   ```

4. Run tests:

   ```bash
   pnpm test
   ```

5. Optional: typecheck and lint:

   ```bash
   pnpm run typecheck
   pnpm run lint
   ```

## Notes

- Default DB path is `./db/cue.db` (override with `DB_PATH`).
- `pnpm run screen` exits with an error in Phase 1; the signal engine is exercised via `pnpm test` and imports from `src/strategy/`.
