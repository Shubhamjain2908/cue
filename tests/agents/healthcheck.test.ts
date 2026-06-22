import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createCueLogger } from "../../src/cli/cue-logger.js";

import {
  checkIngestStaleness,
  checkPipelineStepState,
  checkQqqLag,
  checkStalePositions,
  runHealthcheck,
} from "../../src/agents/healthcheck.js";
import type { AppConfig } from "../../src/config/index.js";
import {
  insertDailyPrices,
  insertPosition,
  insertSignal,
  setPipelineState,
} from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";
import { resolveLastETSession } from "../../src/ingestors/massive-price-ingestor.js";

type SqliteConnection = InstanceType<typeof Database>;

/** Sunday ~10:00 ET (EST) — post-rebalance healthcheck (2026-01-11 is Sunday; REBALANCE_DAY_OF_WEEK=0). */
const SUNDAY_REBALANCE_HEALTHCHECK = new Date("2026-01-11T15:00:00.000Z");

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

function silentLogger(): ReturnType<typeof createCueLogger> {
  return createCueLogger("test", { silent: true });
}

function seedDailyPrices(db: SqliteConnection, sessionDate: string, tickers: string[] = ["QQQ"]): void {
  const bar = { date: sessionDate, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 };
  for (const ticker of tickers) {
    insertDailyPrices(db, ticker, [bar]);
  }
}

function seedStopDayOpenBook(db: SqliteConnection): void {
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
}

describe("runHealthcheck", () => {
  it("sends pass Telegram and returns 0 when all checks pass", async () => {
    const db = openMemoryDb();
    const now = SUNDAY_REBALANCE_HEALTHCHECK;
    const expectedSession = resolveLastETSession(now);

    seedDailyPrices(db, expectedSession);
    insertSignal(db, {
      ticker: "AAPL",
      date: expectedSession,
      signal: "BUY",
      price: 100,
      momentumRank: 1,
      universeRankedCount: 50,
      momentum12_1Return: 0.1,
      atr14: 2,
      initialAtrStop: 90,
    });
    setPipelineState(db, "step:ingest:last_exit_code", "0");
    setPipelineState(db, "step:screen:last_exit_code", "0");

    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
    });

    expect(code).toBe(0);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("✅ Cue healthcheck passed");
    expect(text).toContain("daily_prices current to");
    expect(text).toContain(`signals present for session ${expectedSession}`);
    expect(text).toContain("pipeline_step_state:");
    db.close();
  });

  it("fails ingest when daily_prices is behind expected session", async () => {
    const db = openMemoryDb();
    const now = SUNDAY_REBALANCE_HEALTHCHECK;
    const expectedSession = resolveLastETSession(now);

    seedDailyPrices(db, "2020-01-02");
    insertSignal(db, {
      ticker: "AAPL",
      date: "2026-01-11",
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
    });

    expect(code).toBe(1);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("⚠️ Cue healthcheck FAILED");
    expect(text).toContain("ingest:");
    expect(text).toContain(`expected >= ${expectedSession}`);
    db.close();
  });

  it("fails on Sunday rebalance day when no signals exist and no open positions", async () => {
    const db = openMemoryDb();
    const now = SUNDAY_REBALANCE_HEALTHCHECK;
    const expectedSession = resolveLastETSession(now);
    seedDailyPrices(db, expectedSession);

    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
    });

    expect(code).toBe(1);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain(`no signals for rebalance session ${expectedSession}`);
    db.close();
  });

  it("passes Sunday rebalance with zero-churn (no new signals, open book held, screen exited 0)", async () => {
    const db = openMemoryDb();
    const now = SUNDAY_REBALANCE_HEALTHCHECK;
    const expectedSession = resolveLastETSession(now);
    seedDailyPrices(db, expectedSession, ["QQQ", "AAPL"]);
    seedStopDayOpenBook(db);
    setPipelineState(db, "step:ingest:last_exit_code", "0");
    setPipelineState(db, "step:screen:last_exit_code", "0");

    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
    });

    expect(code).toBe(0);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("zero-churn rebalance");
    expect(text).toContain(expectedSession);
    db.close();
  });

  it("fails when a critical pipeline step last exited non-zero", async () => {
    const db = openMemoryDb();
    const now = MONDAY_HEALTHCHECK;
    const session = resolveLastETSession(now);
    seedDailyPrices(db, session, ["QQQ", "AAPL"]);
    seedStopDayOpenBook(db);
    setPipelineState(db, "step:ingest:last_exit_code", "0");
    setPipelineState(db, "step:execute-stops:last_exit_code", "1");
    setPipelineState(db, "step:execute-stops:last_run_at", "2026-01-05T11:00:00.000Z");

    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
    });

    expect(code).toBe(1);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("pipeline_step_state:");
    expect(text).toContain("execute-stops exited 1");
    db.close();
  });

  it("passes pipeline step check on cold DB without failing on missing keys", async () => {
    const db = openMemoryDb();
    const now = MONDAY_HEALTHCHECK;
    const session = resolveLastETSession(now);
    seedDailyPrices(db, session, ["QQQ", "AAPL"]);
    seedStopDayOpenBook(db);

    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
    });

    expect(code).toBe(0);
    const text = sendTelegram.mock.calls[0]![0] as string;
    expect(text).toContain("✅");
    expect(text).toContain("All critical steps exited 0");
    db.close();
  });

  it("returns 1 when Telegram delivery fails", async () => {
    const db = openMemoryDb();
    const now = MONDAY_HEALTHCHECK;
    const session = resolveLastETSession(now);
    seedDailyPrices(db, session, ["QQQ", "AAPL"]);
    seedStopDayOpenBook(db);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sendTelegram = vi.fn().mockRejectedValue(new Error("network down"));
    const code = await runHealthcheck(db, mockConfig, silentLogger(), {
      now: () => now,
      sendTelegram,
    });

    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    db.close();
  });
});

describe("checkPipelineStepState", () => {
  it("passes when stop-mode critical steps exited 0", () => {
    const db = openMemoryDb();
    setPipelineState(db, "step:ingest:last_exit_code", "0");
    setPipelineState(db, "step:execute-stops:last_exit_code", "0");

    const result = checkPipelineStepState(db, "stop");
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("All critical steps exited 0");
    db.close();
  });

  it("fails when execute-stops last exited 1", () => {
    const db = openMemoryDb();
    setPipelineState(db, "step:ingest:last_exit_code", "0");
    setPipelineState(db, "step:execute-stops:last_exit_code", "1");
    setPipelineState(db, "step:execute-stops:last_run_at", "2026-01-05T11:00:00.000Z");

    const result = checkPipelineStepState(db, "stop");
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("execute-stops exited 1");
    db.close();
  });

  it("does not fail when step keys are missing (cold start)", () => {
    const db = openMemoryDb();
    const result = checkPipelineStepState(db, "stop");
    expect(result.status).toBe("PASS");
    db.close();
  });
});

describe("checkIngestStaleness", () => {
  it("fails when last_ingest_was_stale is set", () => {
    const db = openMemoryDb();
    setPipelineState(db, "last_ingest_was_stale", "1");
    const result = checkIngestStaleness(db);
    expect(result.status).toBe("FAIL");
    expect(result.name).toBe("ingest_staleness");
    expect(result.message).toContain("stale prices");
    db.close();
  });

  it("passes when last_ingest_was_stale is unset or 0", () => {
    const db = openMemoryDb();
    expect(checkIngestStaleness(db).status).toBe("PASS");
    setPipelineState(db, "last_ingest_was_stale", "0");
    expect(checkIngestStaleness(db).status).toBe("PASS");
    db.close();
  });
});

describe("checkStalePositions", () => {
  it("fails when OPEN position has no recent daily_prices bar", () => {
    const db = openMemoryDb();
    const now = MONDAY_HEALTHCHECK;
    const session = resolveLastETSession(now);
    seedDailyPrices(db, session, ["QQQ"]);
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

    const result = checkStalePositions(db, now);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("AAPL");
    db.close();
  });
});

describe("checkQqqLag", () => {
  it("warns when QQQ is exactly one session behind expected", () => {
    const db = openMemoryDb();
    const now = MONDAY_HEALTHCHECK;
    const expected = resolveLastETSession(now);
    const [y, m, d] = expected.split("-").map(Number);
    const prior = resolveLastETSession(new Date(Date.UTC(y!, m! - 1, d!, 20, 0, 0)));
    insertDailyPrices(db, "QQQ", [
      { date: prior, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
    ]);

    const result = checkQqqLag(db, now);
    expect(result.status).toBe("WARN");
    expect(result.message).toContain("1 session");
    expect(prior).not.toBe(expected);
    db.close();
  });

  it("fails when QQQ is more than one session behind expected", () => {
    const db = openMemoryDb();
    const now = MONDAY_HEALTHCHECK;
    seedDailyPrices(db, "2020-01-02");

    const result = checkQqqLag(db, now);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("materially behind");
    db.close();
  });
});
