# Cue — US equity signal pipeline

Nasdaq 100 momentum system: SQLite + Massive EOD ingest, live momentum screen (ATR trailing stops), LLM enrichment, Telegram alerts, and a static HTML dashboard. Strategy math and backtest gates are documented in `.cursor/rules/project-spec.md`.

## Requirements

- Node.js 22+
- [pnpm](https://pnpm.io/) 9+ (lockfile targets **pnpm 10** via `packageManager`; use `corepack enable` if needed)
- `better-sqlite3` **v11** ships a wider set of **prebuilt** binaries (same major as other internal projects); if install still compiles from source, you need a working Apple / LLVM toolchain (see [Troubleshooting](#troubleshooting-native-sqlite-build)).

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

   If `better-sqlite3` fails to compile on macOS, use **install JS first, then rebuild native** (see [Troubleshooting: native SQLite build](#troubleshooting-native-sqlite-build) below):

   ```bash
   pnpm install --ignore-scripts
   # then follow the macOS SDK / CXXFLAGS steps and run:
   pnpm run rebuild:native
   ```

2. Copy environment template and adjust values (see `src/config/index.ts` / `.env.example` for required keys):

   ```bash
   cp .env.example .env
   ```

3. Initialize the database (applies all pending SQL migrations in `src/db/migrations/`):

   ```bash
   pnpm run db:init
   ```

   To re-run migrations on an existing file (prints applied/skipped ids):

   ```bash
   pnpm run db:migrate
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

## CLI (`pnpm run cue`)

Entry point: `tsx src/cli.ts` (script name **`cue`**). Granular subcommands for diagnostics and automation:

| Command | Purpose |
|---------|---------|
| `pnpm run cue --help` | List all subcommands |
| `pnpm run cue db:migrate` | Apply numbered `*.sql` under `src/db/migrations/` (`_migrations` ledger) |
| `pnpm run cue ingest` | Massive / Polygon EOD OHLCV (`--ticker` optional) |
| `pnpm run cue enrich-fundamentals` | Yahoo context → disk cache (Phase 4; `--ticker` / `--limit` / `--force`) |
| `pnpm run cue screen` | Live momentum screen (`--ticker` probe, `--force-rebalance`) |
| `pnpm run cue enrich` | LLM enrich pending BUYs |
| `pnpm run cue brief` | Dashboard HTML + Telegram (`--mode`, `--skip-*`, `--open`) |
| `pnpm run cue execute-stops` | Stop-day path only (stops / max-hold, no rebalance BUYs) |
| `pnpm run cue run-all` | One-shot full pipeline (same step order as scheduler) |
| `pnpm run cue schedule` | Long-running ET window scheduler (16:05–16:15) |
| `pnpm run cue doctor` | Config + DB probe + env key presence (no secrets printed) |
| `pnpm run cue pipeline` | Legacy: `--now` = one-shot; no flag = same as `schedule` |

Shortcuts in `package.json` include `ingest`, `screen`, `pipeline`, `pipeline:now`, `schedule`, `run-all`, `doctor`, `execute-stops`, `enrich-fundamentals`, etc.

## Database migrations

- **Source of truth:** `src/db/migrations/*.sql` (lexicographic order).
- **Runner:** `src/db/migrations/migrate.ts` (creates `_migrations`, runs each file once).
- **Public entry:** `src/db/schema.ts` exports `initSchema`, `migrateTracked`, `runDbInitFromConfig`.
- See `src/db/migrations/README.md` for naming conventions.

## Architecture reference

Authoritative high-level architecture, pipeline registry, and locked strategy parameters: **`.cursor/rules/project-spec.md`**. (Optionally keep a personal copy under `spec/` — that directory is gitignored.)

## Troubleshooting: native SQLite build

Symptom: **`fatal error: 'climits' file not found`** while building **`better-sqlite3`**. Cue pins **`better-sqlite3` v11** (like other repos here) so **`prebuild-install` usually downloads a binary** for Node 22 on macOS and you never hit this. If you still see it, the prebuild was missing for your exact ABI and **node-gyp** is compiling from source.

That compile must see the macOS SDK (**`-isysroot`**). Also, **`CXX` must be a single path** (no spaces); see step 2 below.

### Why `CXX="xcrun -sdk macosx clang++"` often still fails

`node-gyp` drives **GNU make**. **`CXX` must be a single executable path** (no spaces). A multi-word `CXX` is split or mishandled, so the C++ compile can run **without** the SDK flags you intended.

### Fix (recommended order)

1. Install all JavaScript dependencies **without** running lifecycle scripts (so `tsx`, `vitest`, etc. are present even when native build fails):

   ```bash
   rm -rf node_modules
   pnpm install --ignore-scripts
   ```

2. In the **same terminal**, set a **single-word** compiler and pass the SDK via **flags**:

   ```bash
   export SDKROOT="$(xcrun --show-sdk-path)"
   export CC="$(command -v clang)"
   export CXX="$(command -v clang++)"
   export CXXFLAGS="-isysroot $SDKROOT -stdlib=libc++"
   export LDFLAGS="-isysroot $SDKROOT"
   pnpm run rebuild:native
   ```

   If `command -v clang++` points at a non-Apple toolchain, use the Command Line Tools binaries explicitly (keep the same `SDKROOT`, `CXXFLAGS`, and `LDFLAGS`):

   ```bash
   export CC="/Library/Developer/CommandLineTools/usr/bin/clang"
   export CXX="/Library/Developer/CommandLineTools/usr/bin/clang++"
   export CXXFLAGS="-isysroot $SDKROOT -stdlib=libc++"
   export LDFLAGS="-isysroot $SDKROOT"
   ```

   Then run `pnpm run rebuild:native`.

3. Then run `pnpm run db:init` and `pnpm test` as usual.

To make native installs reliable, you can add the same `export` block (step 2) to `~/.zshrc` **before** `pnpm install` without `--ignore-scripts`, or always use step 1 + 2 when setting up a new machine.

### If `xcodebuild -license accept` failed

That command only applies when the active developer directory is **full Xcode** (`/Applications/Xcode.app/...`). If `xcode-select -p` prints `/Library/Developer/CommandLineTools`, you are on **CLT-only**; you do **not** need `xcodebuild -license` for this project.

### If headers are still missing

1. Update CLT: **System Settings → General → Software Update**, or:

   ```bash
   softwareupdate --list
   ```

2. Ensure the developer path is sensible:

   ```bash
   xcode-select -p
   sudo xcode-select -s /Library/Developer/CommandLineTools   # CLT only
   # or, if you use full Xcode:
   # sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   ```

3. Confirm the toolchain sees C++ headers:

   ```bash
   xcrun -sdk macosx clang++ -v -E -x c++ /dev/null -o /dev/null
   ```

   You should see `-isysroot .../SDKs/MacOSX.sdk` and an include path under `.../include/c++/v1`.

## Notes

- Default DB path is `./db/cue.db` (override with `DB_PATH`).
- PM2 / VPS: see `deploy/ecosystem.config.cjs` (`tsx src/cli.ts pipeline` or use `cue schedule` after aligning process manager args).
