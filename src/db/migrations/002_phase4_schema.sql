-- Phase 4.0: fundamentals_cache (positions/signals extensions applied programmatically in migrator.ts).
CREATE TABLE IF NOT EXISTS fundamentals_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE (ticker, as_of_date)
);
