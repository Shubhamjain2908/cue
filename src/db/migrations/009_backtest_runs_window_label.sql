BEGIN TRANSACTION;

ALTER TABLE backtest_runs ADD COLUMN window_label TEXT;
ALTER TABLE backtest_runs ADD COLUMN locked       INTEGER NOT NULL DEFAULT 0;

UPDATE backtest_runs SET window_label = '2023-2025 (bull)', locked = 1 WHERE id IN (73, 74);
UPDATE backtest_runs SET window_label = '2022-2025 (extended)'          WHERE id = 80;

COMMIT;
