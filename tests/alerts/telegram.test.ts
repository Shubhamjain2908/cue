import Database from "better-sqlite3";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuyAlertPendingRow } from "../../src/briefing/queries.js";
import { cueLogger } from "../../src/cli/cue-logger.js";
import {
  deriveBuyAlertShares,
  formatTelegramAlert,
  formatTelegramSellAlert,
  parseAlertModeFromArgv,
  sendDailyPulse,
  sendSellAlerts,
  sendWatchlistBenchAlerts,
} from "../../src/briefing/telegram-dispatcher.js";
import type { SellAlertPendingRow } from "../../src/briefing/queries.js";
import type { AppConfig } from "../../src/config/index.js";
import { formatWatchlistBench } from "../../src/briefing/template.js";
import { resetConfigCache } from "../../src/config/index.js";
import { insertDailyPrices, insertPosition, insertSignal } from "../../src/db/queries.js";
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

describe("formatTelegramSellAlert", () => {
  const baseRow: SellAlertPendingRow = {
    id: 1,
    ticker: "AAA",
    entryDate: "2024-01-02",
    entryPrice: 100,
    exitDate: "2024-06-01",
    exitPrice: 95,
    exitReason: "TRAILING_STOP",
  };

  it("labels TRAILING_STOP per cue-reference", () => {
    const text = formatTelegramSellAlert(baseRow);
    expect(text).toContain("🔴 TRAILING_STOP");
  });

  it("labels TIME_EXIT per cue-reference", () => {
    const text = formatTelegramSellAlert({ ...baseRow, exitReason: "TIME_EXIT" });
    expect(text).toContain("⏱ TIME_EXIT");
  });
});

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

function sampleBuyAlertRow(overrides: Partial<BuyAlertPendingRow> = {}): BuyAlertPendingRow {
  return {
    id: 42,
    ticker: "NVDA",
    date: "2024-06-10",
    signal: "BUY",
    price: 100,
    alerted: 0,
    momentumRank: 1,
    universeRankedCount: 10,
    momentum12_1Return: 0.5,
    atr14: 2.5,
    initialAtrStop: 90,
    sentiment: "BULLISH",
    rationale: "Strong momentum and AI demand tailwinds support the entry thesis here.",
    earningsDate: null,
    sector: "Technology",
    confidence: "HIGH",
    enrichmentStatus: "OK",
    ...overrides,
  };
}

describe("deriveBuyAlertShares fallback cap", () => {
  const row = sampleBuyAlertRow({ price: 50 });

  function fallbackConfig(overrides: Partial<AppConfig>): AppConfig {
    return {
      POSITION_SIZE_USD: 10_000,
      MAX_POSITIONS: 3,
      PORTFOLIO_VALUE_USD: undefined,
      ...overrides,
    } as AppConfig;
  }

  it("caps shares at 5% of implied book when raw sizing exceeds cap", () => {
    const { shares } = deriveBuyAlertShares(row, fallbackConfig({ POSITION_SIZE_USD: 10_000 }));
    expect(shares).toBe(30);
  });

  it("does not clamp when rawShares is below the 5% cap", () => {
    const { shares } = deriveBuyAlertShares(
      row,
      fallbackConfig({ POSITION_SIZE_USD: 1_000, MAX_POSITIONS: 30 }),
    );
    expect(shares).toBe(20);
  });

  it("floors shares to 1 when entry mid is extreme", () => {
    const { shares } = deriveBuyAlertShares(
      sampleBuyAlertRow({ price: 999_999 }),
      fallbackConfig({ POSITION_SIZE_USD: 1_000 }),
    );
    expect(shares).toBe(1);
  });
});

describe("formatTelegramAlert", () => {
  beforeEach(() => {
    envForTelegram();
  });

  afterEach(() => {
    Object.assign(process.env, savedEnv);
    resetConfigCache();
  });

  it("includes quantitative fields and enrichment warning when status is not OK", () => {
    const text = formatTelegramAlert(
      sampleBuyAlertRow({
        enrichmentStatus: "TIMEOUT",
        rationale: "[enrichment unavailable]",
        sentiment: "UNKNOWN",
        confidence: "UNKNOWN",
      }),
    );
    expect(text).toContain("Entry range");
    expect(text).toContain("Stop loss");
    expect(text).toContain("1R target");
    expect(text).toContain("⚠️ enrichment unavailable (TIMEOUT)");
  });

  it("omits enrichment warning when status is OK", () => {
    const text = formatTelegramAlert(sampleBuyAlertRow());
    expect(text).toContain("Strong momentum");
    expect(text).not.toContain("enrichment unavailable");
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
    expect(text).toContain("#4 of 101");
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
      "Semiconductor capex cycle recovery continues with leading wafer fab equipment exposure and margin expansion. " +
      "Foundry utilization is improving into the second half as advanced packaging demand accelerates and customers refresh tool sets for next-node ramps. " +
      "Management commentary points to sustained gross margin leverage as mix shifts toward higher-value inspection and deposition platforms across memory and logic.";
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
    expect(text).toMatch(/#7 of 101\s+KLAC\s+\$1921\.71/);
    expect(text).toMatch(/#8 of 101\s+GOOGL\s+\$380\.34/);
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

const TELEGRAM_MIN_INTERVAL_MS = 1100;

function barsFromCloses(
  closes: number[],
  startDate = "2024-01-02",
): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> {
  return closes.map((close, i) => {
    const ms = Date.parse(`${startDate}T12:00:00Z`) + i * 86_400_000;
    const dt = new Date(ms);
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const da = String(dt.getUTCDate()).padStart(2, "0");
    return {
      date: `${y}-${mo}-${da}`,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
    };
  });
}

function seedQqqForPulse(db: InstanceType<typeof Database>): void {
  const closes = Array.from({ length: 220 }, (_, i) => 90 + i * 0.2);
  insertDailyPrices(db, "QQQ", barsFromCloses(closes));
}

function seedClosedSellAlert(
  db: InstanceType<typeof Database>,
  ticker: string,
  exitDate: string,
): { sellSignalId: number } {
  const entryDate = "2024-01-02";
  const buy = insertSignal(db, {
    ticker,
    date: entryDate,
    signal: "BUY",
    price: 100,
    momentumRank: 1,
    universeRankedCount: 10,
    momentum12_1Return: 0.5,
    atr14: 2.5,
    initialAtrStop: 90,
  });
  const signalId = Number(buy.lastInsertRowid);
  const pos = insertPosition(db, {
    signalId,
    entryDate,
    entryPrice: 100,
    status: "OPEN",
  });
  db.prepare(
    `
    UPDATE positions
    SET status = 'CLOSED', exit_date = @exitDate, exit_price = @exitPrice, exit_reason = 'TRAILING_STOP'
    WHERE id = @id
  `,
  ).run({
    id: Number(pos.lastInsertRowid),
    exitDate,
    exitPrice: 95,
  });
  const sell = insertSignal(db, { ticker, date: exitDate, signal: "SELL", price: 95 });
  return { sellSignalId: Number(sell.lastInsertRowid) };
}

function alertedForSignal(db: InstanceType<typeof Database>, signalId: number): number {
  return (db.prepare(`SELECT alerted FROM signals WHERE id = ?`).get(signalId) as { alerted: number })
    .alerted;
}

describe("sendAndMark / alert pacing", () => {
  beforeEach(() => {
    envForTelegram();
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });
  });

  afterEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.useRealTimers();
    Object.assign(process.env, savedEnv);
    resetConfigCache();
  });

  it("marks only successful sends and aborts the queue on HTTP failure", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);

    const exitDate = "2024-06-10";
    const a = seedClosedSellAlert(db, "AAA", exitDate);
    const b = seedClosedSellAlert(db, "BBB", exitDate);
    const c = seedClosedSellAlert(db, "CCC", exitDate);

    let postCount = 0;
    vi.mocked(axios.post).mockImplementation(async () => {
      postCount++;
      if (postCount === 2) {
        return { status: 429, data: { ok: false, description: "Too Many Requests" } };
      }
      return { status: 200, data: { ok: true } };
    });

    await expect(sendSellAlerts(db)).rejects.toThrow(/HTTP 429/);

    expect(alertedForSignal(db, a.sellSignalId)).toBe(1);
    expect(alertedForSignal(db, b.sellSignalId)).toBe(0);
    expect(alertedForSignal(db, c.sellSignalId)).toBe(0);
    expect(postCount).toBe(2);
    db.close();
  });

  it("marks all signals alerted after every send succeeds", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);

    const exitDate = "2024-06-10";
    const a = seedClosedSellAlert(db, "AAA", exitDate);
    const b = seedClosedSellAlert(db, "BBB", exitDate);
    const c = seedClosedSellAlert(db, "CCC", exitDate);

    await sendSellAlerts(db);

    expect(alertedForSignal(db, a.sellSignalId)).toBe(1);
    expect(alertedForSignal(db, b.sellSignalId)).toBe(1);
    expect(alertedForSignal(db, c.sellSignalId)).toBe(1);
    expect(axios.post).toHaveBeenCalledTimes(3);
    db.close();
  });

  it("paces consecutive sends by at least TELEGRAM_MIN_INTERVAL_MS", async () => {
    vi.useFakeTimers();
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);

    seedClosedSellAlert(db, "AAA", "2024-06-10");
    seedClosedSellAlert(db, "BBB", "2024-06-10");

    const run = sendSellAlerts(db);
    await Promise.resolve();
    expect(axios.post).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TELEGRAM_MIN_INTERVAL_MS - 1);
    expect(axios.post).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(axios.post).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(TELEGRAM_MIN_INTERVAL_MS);
    await run;
    db.close();
  });

  it("sendDailyPulse does not set signals.alerted", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    seedQqqForPulse(db);

    const buy = insertSignal(db, {
      ticker: "ZZZ",
      date: "2024-06-01",
      signal: "BUY",
      price: 50,
      momentumRank: 1,
      universeRankedCount: 10,
      momentum12_1Return: 0.1,
      atr14: 2,
      initialAtrStop: 45,
    });
    insertPosition(db, {
      signalId: Number(buy.lastInsertRowid),
      entryDate: "2024-06-01",
      entryPrice: 50,
      status: "OPEN",
    });
    insertDailyPrices(db, "ZZZ", barsFromCloses([50, 51, 52], "2024-05-28"));

    await sendDailyPulse(db, 0);

    const row = db.prepare(`SELECT alerted FROM signals WHERE ticker = 'ZZZ'`).get() as {
      alerted: number;
    };
    expect(row.alerted).toBe(0);
    expect(axios.post).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("suppresses Daily Pulse when no open positions and no sells", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    seedQqqForPulse(db);
    const infoSpy = vi.spyOn(cueLogger, "info");

    await sendDailyPulse(db, 0);

    expect(axios.post).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "Daily Pulse suppressed — no open positions and no sells fired.",
    );
    infoSpy.mockRestore();
    db.close();
  });

  it("sends Daily Pulse when sellCount > 0 even with no open positions", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    seedQqqForPulse(db);

    await sendDailyPulse(db, 1);

    expect(axios.post).toHaveBeenCalledTimes(1);
    db.close();
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
