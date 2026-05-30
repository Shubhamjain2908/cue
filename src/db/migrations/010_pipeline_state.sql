-- Scheduler idempotency: persist last successful ET run date across PM2 restarts.
CREATE TABLE IF NOT EXISTS pipeline_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
