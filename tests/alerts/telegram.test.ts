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
  it("formats enriched bench with confidence, earnings, and rationale", () => {
    const text = formatWatchlistBench(
      [
        {
          id: 1,
          ticker: "AMD",
          momentumRank: 4,
          price: 172.34,
          atr14: 2,
          momentum12_1Return: 2.03,
          sentiment: "bullish",
          confidence: "HIGH",
          sector: "Technology",
          rationale:
            "AI accelerator demand recovery; analyst upgrades on data centre GPU attach rate.",
          earningsFlag: 1,
          earningsDate: "2026-07-29",
        },
      ],
      "2026-05-29",
    );
    expect(text).toContain("📊 Next in Rank — 2026-05-29");
    expect(text).toContain("#4  AMD");
    expect(text).toContain("$172.34");
    expect(text).toContain("12-1: 2.03");
    expect(text).toContain("BULLISH HIGH");
    expect(text).toContain("| Technology | Earnings: 2026-07-29");
    expect(text).toContain("AI accelerator demand recovery");
    expect(text).toContain("not an entry signal");
  });

  it("omits rationale line when null and shows no earnings near", () => {
    const text = formatWatchlistBench(
      [
        {
          id: 2,
          ticker: "MRVL",
          momentumRank: 5,
          price: 98.12,
          atr14: 1,
          momentum12_1Return: 1.61,
          sentiment: "bullish",
          confidence: "HIGH",
          sector: "Technology",
          rationale: null,
          earningsFlag: 0,
          earningsDate: null,
        },
      ],
      "2026-05-29",
    );
    expect(text).toContain("BULLISH HIGH");
    expect(text).toContain("No earnings near");
    expect(text).not.toMatch(/\n  [^\n]+/);
  });

  it("skips boilerplate opening sentence and uses the next one", () => {
    const text = formatWatchlistBench(
      [
        {
          id: 3,
          ticker: "AMD",
          momentumRank: 4,
          price: 172.34,
          atr14: 1,
          momentum12_1Return: 2.03,
          sentiment: "bullish",
          confidence: "HIGH",
          sector: "Technology",
          rationale:
            "The sentiment for AMD is bullish, driven by several highly positive news headlines. Custom silicon wins are accelerating design-ins.",
          earningsFlag: 0,
          earningsDate: null,
        },
      ],
      "2026-05-29",
    );
    expect(text).toContain("Custom silicon wins");
    expect(text).not.toContain("The sentiment for AMD");
  });

  it("truncates long rationale at a word boundary", () => {
    const long =
      "Semiconductor capex cycle recovery continues with leading wafer fab equipment exposure and margin expansion across memory and logic.";
    const text = formatWatchlistBench(
      [
        {
          id: 3,
          ticker: "AMAT",
          momentumRank: 6,
          price: 187.45,
          atr14: 1,
          momentum12_1Return: 1.57,
          sentiment: "bullish",
          confidence: "HIGH",
          sector: "Technology",
          rationale: long,
          earningsFlag: 1,
          earningsDate: "2026-08-14",
        },
      ],
      "2026-05-29",
    );
    expect(text).toContain("…");
    expect(text).not.toContain("memory and logic");
  });

  it("aligns price column for wide tickers and large prices", () => {
    const text = formatWatchlistBench(
      [
        {
          id: 7,
          ticker: "KLAC",
          momentumRank: 7,
          price: 1921.71,
          atr14: 1,
          momentum12_1Return: 1.51,
          sentiment: "bullish",
          confidence: "MEDIUM",
          sector: "Technology",
          rationale: null,
          earningsFlag: 0,
          earningsDate: null,
        },
        {
          id: 8,
          ticker: "GOOGL",
          momentumRank: 8,
          price: 380.34,
          atr14: 1,
          momentum12_1Return: 1.08,
          sentiment: "bullish",
          confidence: "HIGH",
          sector: "Communication Services",
          rationale: null,
          earningsFlag: 0,
          earningsDate: null,
        },
      ],
      "2026-05-29",
    );
    expect(text).toMatch(/#7\s+KLAC\s+\$1921\.71/);
    expect(text).toMatch(/#8\s+GOOGL\s+\$380\.34/);
  });

  it("abbreviates Communication Services sector label", () => {
    const text = formatWatchlistBench(
      [
        {
          id: 4,
          ticker: "GOOGL",
          momentumRank: 8,
          price: 397.86,
          atr14: 1,
          momentum12_1Return: 1.08,
          sentiment: "bullish",
          confidence: "HIGH",
          sector: "Communication Services",
          rationale: "Cloud re-acceleration.",
          earningsFlag: 1,
          earningsDate: "2026-07-23",
        },
      ],
      "2026-05-29",
    );
    expect(text).toContain("Comm. Services");
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
