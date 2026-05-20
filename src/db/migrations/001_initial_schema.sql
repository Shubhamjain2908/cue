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
  signal_type TEXT NOT NULL DEFAULT 'MOMENTUM',
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
  exit_price REAL,
  highest_close_since_entry REAL,
  current_stop_loss REAL
);
