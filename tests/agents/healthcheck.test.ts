import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import winston from "winston";

import { checkPm2Logs, runHealthcheck } from "../../src/agents/healthcheck.js";
import type { AppConfig } from "../../src/config/index.js";
import { insertDailyPrices, insertPosition, insertSignal } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";
import { resolveLastETSession } from "../../src/ingestors/massive-price-ingestor.js";

type SqliteConnection = InstanceType<typeof Database>;

/** Friday 17:00 ET (EST) — post-pipeline healthcheck window (2026-01-09 is Friday). */
const FRIDAY_HEALTHCHECK = new Date("2026-01-09T22:00:00.000Z");

/** Monday 17:00 ET (EST) — stop-day healthcheck (2026-01-05). */
const MONDAY_HEALTHCHECK = new Date("2026-01-05T22:00:00.000Z");

const mockConfig = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "test-chat",
} as AppConfig;

function openMemoryDb(): SqliteConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function silentLogger(): winston.Logger {
  return winston.createLogger({ silent: true });
}

function seedDailyPrices(db: SqliteConnection, sessionDate: string): void {
  insertDailyPrices(db, "QQQ", [
    { date: sessionDate, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
  ]);
}

describe("runHealthcheck", () => {
  it("sends pass Telegram and returns 0 when all checks pass", async () => {
    const db = openMemoryDb();
    const now = FRIDAY_HEALTHCHECK;
    const expectedSession = resolveLastETSession(now);
    const todayEt = "2026-01-09";

    seedDailyPrices(db, expectedSession);
    insertSignal(db, {
      ticker: "AAPL",
      date: todayEt,
      signal: "BUY",
      price: 100,
      momentumRank: 1,
      universeRankedCount: 50,
      momentum12_1Return: 0.1,
      atr14: 2,
      initialAtrStop: 90,
    });

    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
      resolveLogPath: () => path.join(os.tmpdir(), "cue-healthcheck-missing.log"),
    });

    expect(code).toBe(0);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("✅ Cue healthcheck passed");
    expect(text).toContain("daily_prices current to");
    expect(text).toContain(`signals present for ${todayEt}`);
    expect(text).toContain("log file not found");
    db.close();
  });

  it("fails ingest when daily_prices is behind expected session", async () => {
    const db = openMemoryDb();
    const now = FRIDAY_HEALTHCHECK;
    const expectedSession = resolveLastETSession(now);

    seedDailyPrices(db, "2020-01-02");
    insertSignal(db, {
      ticker: "AAPL",
      date: "2026-01-09",
      signal: "BUY",
      price: 100,
      momentumRank: 1,
      universeRankedCount: 50,
      momentum12_1Return: 0.1,
      atr14: 2,
      initialAtrStop: 90,
    });

    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
      resolveLogPath: () => path.join(os.tmpdir(), "cue-healthcheck-missing.log"),
    });

    expect(code).toBe(1);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("⚠️ Cue healthcheck FAILED");
    expect(text).toContain("ingest:");
    expect(text).toContain(`expected >= ${expectedSession}`);
    db.close();
  });

  it("fails on Friday when no signals exist for today_et", async () => {
    const db = openMemoryDb();
    const now = FRIDAY_HEALTHCHECK;
    seedDailyPrices(db, resolveLastETSession(now));

    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
      resolveLogPath: () => path.join(os.tmpdir(), "cue-healthcheck-missing.log"),
    });

    expect(code).toBe(1);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("no signals for rebalance session 2026-01-09");
    db.close();
  });

  it("fails when recent error-level log lines are present", async () => {
    const db = openMemoryDb();
    const now = MONDAY_HEALTHCHECK;
    seedDailyPrices(db, resolveLastETSession(now));
    insertSignal(db, {
      ticker: "AAPL",
      date: "2026-01-02",
      signal: "BUY",
      price: 100,
      momentumRank: 1,
      universeRankedCount: 50,
      momentum12_1Return: 0.1,
      atr14: 2,
      initialAtrStop: 90,
    });
    const signalId = (db.prepare(`SELECT id FROM signals`).get() as { id: number }).id;
    insertPosition(db, {
      signalId,
      entryDate: "2026-01-02",
      entryPrice: 100,
      status: "OPEN",
    });

    const logPath = path.join(os.tmpdir(), `cue-healthcheck-err-${process.pid}.log`);
    const errLine = `${now.toISOString()} pipeline error: simulated PM2 failure`;
    fs.writeFileSync(logPath, `${errLine}\n`, "utf8");

    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
      resolveLogPath: () => logPath,
    });

    expect(code).toBe(1);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("pm2_logs:");
    expect(text).toContain("simulated PM2 failure");
    fs.unlinkSync(logPath);
    db.close();
  });

  it("skips missing log file without failing overall", async () => {
    const db = openMemoryDb();
    const now = MONDAY_HEALTHCHECK;
    seedDailyPrices(db, resolveLastETSession(now));
    insertSignal(db, {
      ticker: "AAPL",
      date: "2026-01-02",
      signal: "BUY",
      price: 100,
      momentumRank: 1,
      universeRankedCount: 50,
      momentum12_1Return: 0.1,
      atr14: 2,
      initialAtrStop: 90,
    });
    const signalId = (db.prepare(`SELECT id FROM signals`).get() as { id: number }).id;
    insertPosition(db, {
      signalId,
      entryDate: "2026-01-02",
      entryPrice: 100,
      status: "OPEN",
    });

    const missingLog = path.join(os.tmpdir(), `cue-healthcheck-nolog-${process.pid}.log`);
    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
      resolveLogPath: () => missingLog,
    });

    expect(code).toBe(0);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("✅");
    expect(text).toContain("log file not found");
    db.close();
  });

  it("returns 1 when Telegram delivery fails", async () => {
    const db = openMemoryDb();
    const now = MONDAY_HEALTHCHECK;
    seedDailyPrices(db, resolveLastETSession(now));
    insertSignal(db, {
      ticker: "AAPL",
      date: "2026-01-02",
      signal: "BUY",
      price: 100,
      momentumRank: 1,
      universeRankedCount: 50,
      momentum12_1Return: 0.1,
      atr14: 2,
      initialAtrStop: 90,
    });
    const signalId = (db.prepare(`SELECT id FROM signals`).get() as { id: number }).id;
    insertPosition(db, {
      signalId,
      entryDate: "2026-01-02",
      entryPrice: 100,
      status: "OPEN",
    });

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sendTelegram = vi.fn().mockRejectedValue(new Error("network down"));
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
      resolveLogPath: () => path.join(os.tmpdir(), "cue-healthcheck-missing.log"),
    });

    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    db.close();
  });
});

describe("checkPm2Logs", () => {
  it("returns SKIP when log path is absent", () => {
    const missing = path.join(os.tmpdir(), `cue-healthcheck-skip-${process.pid}.log`);
    const result = checkPm2Logs(missing, new Date());
    expect(result.status).toBe("SKIP");
  });
});
