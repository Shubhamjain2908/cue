import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractDashboardPayload } from "../../src/briefing/queries.js";
import { resetConfigCache } from "../../src/config/index.js";

type SqliteConnection = InstanceType<typeof Database>;

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-test-queries-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.DB_PATH = dbPath;
  resetConfigCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildTestDb(): Database.Database {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_prices (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume INTEGER NOT NULL,
      created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (ticker, date)
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      signal TEXT NOT NULL CHECK(signal IN ('BUY','SELL','HOLD')),
      signal_type TEXT DEFAULT 'MOMENTUM',
      price REAL NOT NULL,
      alerted INTEGER DEFAULT 0,
      momentum_rank INTEGER,
      universe_ranked_count INTEGER,
      momentum_12_1_return REAL,
      atr14 REAL,
      initial_atr_stop REAL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL REFERENCES signals(id),
      entry_date TEXT NOT NULL,
      entry_price REAL NOT NULL,
      exit_date TEXT,
      exit_price REAL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
      current_stop_loss REAL,
      highest_close_since_entry REAL
    );

    CREATE TABLE IF NOT EXISTS enrichments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL REFERENCES signals(id),
      sentiment TEXT NOT NULL,
      rationale TEXT NOT NULL,
      earnings_flag INTEGER DEFAULT 0,
      earnings_date TEXT,
      sector TEXT,
      sector_trend TEXT,
      headlines TEXT,
      confidence TEXT NOT NULL CHECK(confidence IN ('HIGH','MEDIUM','LOW'))
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
      benchmark_cagr REAL,
      expectancy REAL
    );
  `);

  return db;
}

function seedTestData(db: SqliteConnection): void {
  const insertQqq = db.prepare(`
    INSERT OR IGNORE INTO daily_prices (ticker, date, open, high, low, close, volume)
    VALUES ('QQQ', ?, 380, 390, 375, ?, 45000000)
  `);
  for (let i = 200; i >= 1; i--) {
    const mo = String(Math.min(Math.ceil(i / 28), 12)).padStart(2, "0");
    const day = String((i % 28) + 1).padStart(2, "0");
    insertQqq.run(`2023-${mo}-${day}`, 380 + Math.random() * 40);
  }

  db.prepare(`
    INSERT INTO daily_prices (ticker, date, open, high, low, close, volume)
    VALUES ('AAPL', '2024-01-15', 185, 187, 183, 186, 60000000)
  `).run();
  db.prepare(`
    INSERT INTO daily_prices (ticker, date, open, high, low, close, volume)
    VALUES ('AAPL', '2024-01-10', 180, 182, 178, 181, 55000000)
  `).run();

  const sigResult = db.prepare(`
    INSERT INTO signals (ticker, date, signal, signal_type, price, alerted, momentum_rank, universe_ranked_count, momentum_12_1_return, atr14, initial_atr_stop)
    VALUES ('AAPL', '2024-01-10', 'BUY', 'MOMENTUM', 181, 1, 2, 100, 0.15, 3.5, 170)
  `).run();
  const signalId = Number(sigResult.lastInsertRowid);

  db.prepare(`
    INSERT INTO positions (signal_id, entry_date, entry_price, status, current_stop_loss, highest_close_since_entry)
    VALUES (?, '2024-01-10', 181, 'OPEN', 172, 186)
  `).run(signalId);

  db.prepare(`
    INSERT INTO enrichments (signal_id, sentiment, rationale, earnings_flag, earnings_date, sector, sector_trend, headlines, confidence)
    VALUES (?, 'bullish', 'Strong revenue growth and expanding margins', 0, NULL, 'Technology', 'positive', 'Apple reports record quarter', 'HIGH')
  `).run(signalId);

  db.prepare(`
    INSERT INTO backtest_runs (run_date, from_date, to_date, cagr, max_drawdown, win_rate, sharpe_ratio, total_trades, benchmark_cagr, expectancy)
    VALUES ('2024-01-15', '2023-01-01', '2023-12-31', 15.5, 12.3, 60.0, 1.2, 50, 10.2, 4.5)
  `).run();
}

describe("extractDashboardPayload", () => {
  it("builds a dashboard payload with open positions, signals, backtest summary, and sector allocation", () => {
    const db = buildTestDb();
    seedTestData(db);
    db.close();

    const payload = extractDashboardPayload();

    expect(payload).toHaveProperty("generated_at");
    expect(payload).toHaveProperty("regime_active");
    expect(Array.isArray(payload.open_positions)).toBe(true);
    expect(Array.isArray(payload.recent_signals)).toBe(true);

    expect(payload.open_positions.length).toBeGreaterThanOrEqual(1);
    if (payload.open_positions.length > 0) {
      const pos = payload.open_positions[0]!;
      expect(pos).toHaveProperty("ticker");
      expect(pos).toHaveProperty("entry_date");
      expect(pos).toHaveProperty("entry_price");
      expect(pos).toHaveProperty("current_stop_loss");
      expect(pos).toHaveProperty("highest_close_since_entry");
      expect(pos).toHaveProperty("current_close");
      expect(pos).toHaveProperty("days_held");
    }

    expect(payload.recent_signals.length).toBeGreaterThanOrEqual(1);
    if (payload.recent_signals.length > 0) {
      const sig = payload.recent_signals[0]!;
      expect(sig.ticker).toBe("AAPL");
      expect(["BUY", "SELL"]).toContain(sig.signal_type);
    }

    if (payload.backtest_summary !== null) {
      expect(payload.backtest_summary).toHaveProperty("cagr");
      expect(payload.backtest_summary).toHaveProperty("sharpe");
      expect(payload.backtest_summary).toHaveProperty("total_trades");
    }

    expect(Array.isArray(payload.sector_allocation)).toBe(true);
  });

  it("returns a payload with all required fields even on empty DB", () => {
    const db = buildTestDb();
    const insertQqq = db.prepare(`
      INSERT OR IGNORE INTO daily_prices (ticker, date, open, high, low, close, volume)
      VALUES ('QQQ', ?, 380, 390, 375, ?, 45000000)
    `);
    for (let i = 200; i >= 1; i--) {
      const mo = String(Math.min(Math.ceil(i / 28), 12)).padStart(2, "0");
      const day = String((i % 28) + 1).padStart(2, "0");
      insertQqq.run(`2023-${mo}-${day}`, 380 + Math.random() * 40);
    }
    db.close();

    const payload = extractDashboardPayload();

    expect(payload.open_positions).toEqual([]);
    expect(payload.recent_signals).toEqual([]);
    expect(payload.backtest_summary).toBeNull();
    expect(payload.sector_allocation).toEqual([]);
    expect(payload.regime_active).toBeTypeOf("boolean");
  });
});
