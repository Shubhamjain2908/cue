-- Discriminate backtest_runs by strategy so briefing picks the locked momentum run.
-- Ledger id = filename without `.sql` (`007_backtest_runs_strategy`).

BEGIN TRANSACTION;

ALTER TABLE backtest_runs ADD COLUMN strategy TEXT;

UPDATE backtest_runs SET strategy = 'MOMENTUM'
WHERE id IN (73, 74);

UPDATE backtest_runs SET strategy = 'GARP_RESEARCH'
WHERE id IN (75, 76, 77, 78, 79);

UPDATE backtest_runs SET strategy = 'SWEEP'
WHERE strategy IS NULL;

COMMIT;
