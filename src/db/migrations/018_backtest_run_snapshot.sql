-- Snapshot metadata for backtest reproducibility audit trail.
-- Each new backtest run captures the config, git SHA, and universe
-- fingerprint so locked runs can be reproduced exactly.
-- No data backfill needed (nullable columns).

BEGIN TRANSACTION;

ALTER TABLE backtest_runs ADD COLUMN config_snapshot_json TEXT;
ALTER TABLE backtest_runs ADD COLUMN git_sha TEXT;
ALTER TABLE backtest_runs ADD COLUMN universe_fingerprint TEXT;

COMMIT;
