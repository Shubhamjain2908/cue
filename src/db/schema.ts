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
  rsi14 REAL NOT NULL,
  momentum_5d REAL NOT NULL,
  volume_ratio REAL NOT NULL,
  stop_loss REAL NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0,
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
  benchmark_cagr REAL NOT NULL
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

export function initSchema(db: SqliteConnection): void {
  db.exec(SCHEMA_SQL);
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
