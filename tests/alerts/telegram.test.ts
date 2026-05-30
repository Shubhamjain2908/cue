import Database from "better-sqlite3";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseAlertModeFromArgv,
  sendWatchlistBenchAlerts,
} from "../../src/briefing/telegram-dispatcher.js";
import { formatWatchlistBench } from "../../src/briefing/template.js";
import { resetConfigCache } from "../../src/config/index.js";
import { insertSignal } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";

const savedEnv = { ...process.env };

vi.mock("axios");

function envForTelegram(): void {
  resetConfigCache();
  Object.assign(process.env, savedEnv);
  process.env.POLYGON_API_KEY = "p";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "c";
  process.env.WATCHLIST_BENCH_DEPTH = "5";
}

describe("parseAlertModeFromArgv", () => {
  it("throws when --mode is absent", () => {
    expect(() => parseAlertModeFromArgv(["node", "telegram.ts"])).toThrow(/missing or empty --mode/);
  });

  it("parses --mode stop", () => {
    expect(parseAlertModeFromArgv(["node", "telegram.ts", "--mode", "stop"])).toBe("stop");
  });

  it("parses --mode rebalance", () => {
    expect(parseAlertModeFromArgv(["node", "telegram.ts", "--mode", "rebalance"])).toBe("rebalance");
  });

  it("is case-insensitive for mode value", () => {
    expect(parseAlertModeFromArgv(["node", "telegram.ts", "--mode", "STOP"])).toBe("stop");
  });

  it("throws when mode value is invalid", () => {
    expect(() => parseAlertModeFromArgv(["node", "telegram.ts", "--mode", "daily"])).toThrow(/invalid --mode/);
  });

  it("throws when --mode has no following arg", () => {
    expect(() => parseAlertModeFromArgv(["node", "telegram.ts", "--mode"])).toThrow(/missing or empty --mode/);
  });
});

describe("formatWatchlistBench", () => {
  it("formats bench lines with sentiment and sector", () => {
    const text = formatWatchlistBench(
      [
        {
          id: 1,
          ticker: "MU",
          momentumRank: 4,
          price: 100,
          atr14: 2,
          momentum12_1Return: 0.89,
          sentiment: "bullish",
          confidence: "HIGH",
          sector: "Technology",
          rationale: null,
        },
      ],
      "2026-05-30",
    );
    expect(text).toContain("📊 Next in Rank — 2026-05-30");
    expect(text).toContain("#4  MU");
    expect(text).toContain("12-1: 0.89");
    expect(text).toContain("BULLISH");
    expect(text).toContain("Technology");
    expect(text).toContain("not an entry signal");
  });
});

describe("sendWatchlistBenchAlerts", () => {
  beforeEach(() => {
    envForTelegram();
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });
  });

  afterEach(() => {
    vi.mocked(axios.post).mockReset();
    Object.assign(process.env, savedEnv);
    resetConfigCache();
  });

  it("sends bench message and marks WATCHLIST rows alerted", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);

    const asOf = "2026-05-30";
    insertSignal(db, {
      ticker: "MU",
      date: asOf,
      signal: "WATCHLIST",
      price: 100,
      momentumRank: 4,
      universeRankedCount: 100,
      momentum12_1Return: 0.89,
      atr14: 2,
    });
    await sendWatchlistBenchAlerts(db, asOf);

    expect(axios.post).toHaveBeenCalledTimes(1);
    const body = vi.mocked(axios.post).mock.calls[0]![1] as { text: string };
    expect(body.text).toContain("Next in Rank");

    const alerted = db.prepare(`SELECT alerted FROM signals WHERE signal = 'WATCHLIST'`).get() as {
      alerted: number;
    };
    expect(alerted.alerted).toBe(1);
    db.close();
  });
});
