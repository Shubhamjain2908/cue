-- Phase 4+: fundamentals cache (ledger id = filename without .sql).
CREATE TABLE IF NOT EXISTS fundamentals_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE (ticker, as_of_date)
);
