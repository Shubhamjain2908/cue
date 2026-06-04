import Database from "better-sqlite3";
import winston from "winston";
import { describe, expect, it, vi } from "vitest";

import { getPipelineState } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";
import {
  previousWeekdayBeforeEtCivil,
  resolveSessionDateAndResults,
} from "../../src/ingestors/massive-price-ingestor.js";
import type { MassiveGroupedBar } from "../../src/ingestors/types.js";

function openMemoryDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function silentLogger(): winston.Logger {
  return winston.createLogger({ silent: true, transports: [new winston.transports.Console()] });
}

function seedDateRow(db: InstanceType<typeof Database>, date: string): void {
  db.prepare(
    `
    INSERT INTO daily_prices (ticker, date, open, high, low, close, volume)
    VALUES ('QQQ', @date, 1, 1, 1, 1, 100)
  `,
  ).run({ date });
}

const sampleBar = (ticker: string): MassiveGroupedBar => ({
  T: ticker,
  o: 1,
  h: 1,
  l: 1,
  c: 1,
  v: 100,
});

describe("previousWeekdayBeforeEtCivil", () => {
  it("maps Monday ET to the prior Friday session", () => {
    const now = new Date("2026-05-25T16:05:00-04:00");
    expect(previousWeekdayBeforeEtCivil(now)).toBe("2026-05-22");
  });

  it("maps Tuesday ET to the prior Monday session", () => {
    const now = new Date("2026-05-26T16:05:00-04:00");
    expect(previousWeekdayBeforeEtCivil(now)).toBe("2026-05-25");
  });

  it("maps Sunday ET civil date to the prior Friday session", () => {
    const now = new Date("2026-05-24T12:00:00-04:00");
    expect(previousWeekdayBeforeEtCivil(now)).toBe("2026-05-22");
  });
});

describe("resolveSessionDateAndResults staleness", () => {
  const now = new Date("2026-05-26T20:00:00-04:00");
  const t0 = "2026-05-26";
  const t1 = "2026-05-25";

  it("sets last_ingest_was_stale=1 when T+0 is empty and T-1 date already in daily_prices", async () => {
    const db = openMemoryDb();
    seedDateRow(db, t1);
    const fetchGroupedDailyFn = vi.fn(async ({ dateString }: { dateString: string }) => {
      if (dateString === t0) {
        return [];
      }
      return [sampleBar("QQQ")];
    });

    const resolved = await resolveSessionDateAndResults({
      db,
      apiKey: "key",
      now,
      explicitDate: undefined,
      force: true,
      tickersUpper: ["QQQ"],
      logger: silentLogger(),
      fetchGroupedDailyFn,
    });

    expect(resolved?.sessionDate).toBe(t1);
    expect(getPipelineState(db, "last_ingest_was_stale")).toBe("1");
    db.close();
  });

  it("sets last_ingest_was_stale=0 when T+0 is empty and T-1 is not yet in daily_prices", async () => {
    const db = openMemoryDb();
    const fetchGroupedDailyFn = vi.fn(async ({ dateString }: { dateString: string }) => {
      if (dateString === t0) {
        return [];
      }
      return [sampleBar("QQQ")];
    });

    const resolved = await resolveSessionDateAndResults({
      db,
      apiKey: "key",
      now,
      explicitDate: undefined,
      force: true,
      tickersUpper: ["QQQ"],
      logger: silentLogger(),
      fetchGroupedDailyFn,
    });

    expect(resolved?.sessionDate).toBe(t1);
    expect(getPipelineState(db, "last_ingest_was_stale")).toBe("0");
    db.close();
  });

  it("sets last_ingest_was_stale=0 after successful T+0 ingest", async () => {
    const db = openMemoryDb();
    const fetchGroupedDailyFn = vi.fn(async () => [sampleBar("QQQ")]);

    const resolved = await resolveSessionDateAndResults({
      db,
      apiKey: "key",
      now,
      explicitDate: undefined,
      force: true,
      tickersUpper: ["QQQ"],
      logger: silentLogger(),
      fetchGroupedDailyFn,
    });

    expect(resolved?.sessionDate).toBe(t0);
    expect(getPipelineState(db, "last_ingest_was_stale")).toBe("0");
    expect(fetchGroupedDailyFn).toHaveBeenCalledTimes(1);
    expect(fetchGroupedDailyFn.mock.calls[0]![0].dateString).toBe(t0);
    db.close();
  });
});
