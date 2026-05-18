import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";

type SqliteConnection = InstanceType<typeof Database>;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS daily_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE (ticker, date)
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  signal TEXT NOT NULL,
  price REAL NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0,
  momentum_rank INTEGER,
  universe_ranked_count INTEGER,
  momentum_12_1_return REAL,
  atr14 REAL,
  initial_atr_stop REAL,
  UNIQUE (ticker, date)
);

CREATE TABLE IF NOT EXISTS enrichments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
  sentiment TEXT NOT NULL,
  rationale TEXT NOT NULL,
  earnings_flag INTEGER NOT NULL DEFAULT 0,
  earnings_date TEXT,
  sector TEXT,
  sector_trend TEXT,
  headlines TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'LOW',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  cagr REAL NOT NULL,
  max_drawdown REAL NOT NULL,
  win_rate REAL NOT NULL,
  sharpe_ratio REAL NOT NULL,
  total_trades INTEGER NOT NULL,
  benchmark_cagr REAL NOT NULL,
  expectancy REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  entry_price REAL NOT NULL,
  status TEXT NOT NULL,
  exit_date TEXT,
  exit_price REAL
);
`;

function signalColumnNames(db: SqliteConnection): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(signals)`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function enrichmentColumnNames(db: SqliteConnection): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(enrichments)`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function backtestRunColumnNames(db: SqliteConnection): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(backtest_runs)`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Idempotent migrations for existing SQLite files.
 * - Replaces pre–Phase-2 `signals` (RSI-era columns) with momentum-capable layout.
 * - Adds `enrichments.confidence` when missing.
 *
 * If `signals` still has `rsi14`, rebuilds `signals` in place (FK off) preserving ids for enrichments/positions.
 */
export function migrateSchema(db: SqliteConnection): void {
  const sigCols = signalColumnNames(db);
  if (sigCols.size === 0) {
    return;
  }

  if (sigCols.has("rsi14")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE signals_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        signal TEXT NOT NULL,
        price REAL NOT NULL,
        alerted INTEGER NOT NULL DEFAULT 0,
        momentum_rank INTEGER,
        universe_ranked_count INTEGER,
        momentum_12_1_return REAL,
        atr14 REAL,
        initial_atr_stop REAL,
        UNIQUE (ticker, date)
      );
      INSERT INTO signals_migrated (
        id, ticker, date, signal, price, alerted,
        momentum_rank, universe_ranked_count, momentum_12_1_return, atr14, initial_atr_stop
      )
      SELECT
        id, ticker, date, signal, price, alerted,
        NULL, NULL, NULL, NULL, NULL
      FROM signals;
      DROP TABLE signals;
      ALTER TABLE signals_migrated RENAME TO signals;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } else {
    const stmts: string[] = [];
    if (!sigCols.has("momentum_rank")) {
      stmts.push(`ALTER TABLE signals ADD COLUMN momentum_rank INTEGER`);
    }
    if (!sigCols.has("universe_ranked_count")) {
      stmts.push(`ALTER TABLE signals ADD COLUMN universe_ranked_count INTEGER`);
    }
    if (!sigCols.has("momentum_12_1_return")) {
      stmts.push(`ALTER TABLE signals ADD COLUMN momentum_12_1_return REAL`);
    }
    if (!sigCols.has("atr14")) {
      stmts.push(`ALTER TABLE signals ADD COLUMN atr14 REAL`);
    }
    if (!sigCols.has("initial_atr_stop")) {
      stmts.push(`ALTER TABLE signals ADD COLUMN initial_atr_stop REAL`);
    }
    for (const sql of stmts) {
      db.exec(sql);
    }
  }

  const encCols = enrichmentColumnNames(db);
  if (encCols.size > 0 && !encCols.has("confidence")) {
    db.exec(
      `ALTER TABLE enrichments ADD COLUMN confidence TEXT NOT NULL DEFAULT 'LOW'`,
    );
  }

  const btCols = backtestRunColumnNames(db);
  if (btCols.size > 0 && !btCols.has("expectancy")) {
    db.exec(`ALTER TABLE backtest_runs ADD COLUMN expectancy REAL NOT NULL DEFAULT 0`);
  }
}

export function initSchema(db: SqliteConnection): void {
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
}

function runDbInit(): void {
  const config = getConfig();
  const dbDir = path.dirname(config.DB_PATH);
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(config.DB_PATH);
  try {
    initSchema(db);
  } finally {
    db.close();
  }
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

if (isMain) {
  runDbInit();
}
