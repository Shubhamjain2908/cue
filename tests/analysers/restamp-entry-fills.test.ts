import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { restampPendingEntryFills } from "../../src/analysers/restamp-entry-fills.js";
import {
  insertDailyPrices,
  insertPosition,
  insertSignal,
  insertStopMovement,
} from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";

type SqliteConnection = InstanceType<typeof Database>;

function openMemoryDb(): SqliteConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

/** Signal with Friday close. `entry_price` will match `price` until restamped. */
const FRIDAY_CLOSE = 100;
const FRI_SIGNAL = {
  ticker: "AAPL",
  date: "2026-01-09", // Friday
  signal: "BUY" as const,
  price: FRIDAY_CLOSE,
  momentumRank: 1,
  universeRankedCount: 50,
  momentum12_1Return: 0.1,
  atr14: 2,
  initialAtrStop: 92, // 100 - 4 * 2
};

/** Monday open: the next trading day bar. */
const MONDAY_OPEN = 101;
const MONDAY_BAR = {
  date: "2026-01-12", // Monday
  open: MONDAY_OPEN,
  high: 103,
  low: 100,
  close: 102,
  volume: 100,
};

function seedPositionWithNextBar(
  db: SqliteConnection,
  overrides?: {
    entryPrice?: number;
    entryDate?: string;
    atr14?: number;
  },
): { signalId: number; positionId: number } {
  const ins = insertSignal(db, {
    ...FRI_SIGNAL,
    atr14: overrides?.atr14 ?? FRI_SIGNAL.atr14,
  });
  const signalId = Number(ins.lastInsertRowid);

  insertDailyPrices(db, "AAPL", [
    { date: FRI_SIGNAL.date, open: 99, high: 101, low: 98, close: FRIDAY_CLOSE, volume: 100 },
    MONDAY_BAR,
  ]);

  const pos = insertPosition(db, {
    signalId,
    entryDate: overrides?.entryDate ?? FRI_SIGNAL.date,
    entryPrice: overrides?.entryPrice ?? FRI_SIGNAL.price,
    status: "OPEN",
  });
  const positionId = Number(pos.lastInsertRowid);

  return { signalId, positionId };
}

function seedPositionWithoutNextBar(db: SqliteConnection): { signalId: number; positionId: number } {
  const ins = insertSignal(db, FRI_SIGNAL);
  const signalId = Number(ins.lastInsertRowid);

  // Only Friday bar — no Monday bar
  insertDailyPrices(db, "AAPL", [
    { date: FRI_SIGNAL.date, open: 99, high: 101, low: 98, close: FRIDAY_CLOSE, volume: 100 },
  ]);

  const pos = insertPosition(db, {
    signalId,
    entryDate: FRI_SIGNAL.date,
    entryPrice: FRI_SIGNAL.price,
    status: "OPEN",
  });
  const positionId = Number(pos.lastInsertRowid);

  return { signalId, positionId };
}

function seedPositionWithStopMovement(
  db: SqliteConnection,
): { signalId: number; positionId: number } {
  const { signalId, positionId } = seedPositionWithNextBar(db, { atr14: 3 });

  // Insert a stop_movements row to simulate an already-ratcheted stop.
  // The stop movement sets new_stop = 93. With atr14=3, re-seed would be
  // 101 - 4*3 = 89, so we can distinguish "entry-only" from "full restamp".
  insertStopMovement(db, {
    position_id: positionId,
    as_of_date: "2026-01-12",
    previous_stop: 88, // 100 - 4*3 = 88
    new_stop: 93,
    previous_high: 100,
    new_high: 102,
    stop_regime: "BASE",
    close_price: 102,
    atr14: 3,
  });

  // Simulate screener having already updated positions.current_stop_loss
  // (live system uses COALESCE(p.current_stop_loss, sig.initial_atr_stop)).
  db.prepare(
    `UPDATE positions SET entry_price = ?, current_stop_loss = ? WHERE id = ?`,
  ).run(FRI_SIGNAL.price, 93, positionId);

  return { signalId, positionId };
}

describe("restampPendingEntryFills", () => {
  it("restamps entry_price and stop when next bar exists and stop hasn't moved", () => {
    const db = openMemoryDb();
    const { positionId } = seedPositionWithNextBar(db);

    const count = restampPendingEntryFills(db);

    expect(count).toBe(1);

    const pos = db
      .prepare(`SELECT entry_price, current_stop_loss FROM positions WHERE id = ?`)
      .get(positionId) as { entry_price: number; current_stop_loss: number | null };

    // entry_price should be Monday open (101)
    expect(pos.entry_price).toBe(MONDAY_OPEN);
    // stop should be 101 - 4 * 2 = 93
    expect(pos.current_stop_loss).toBe(93);
    db.close();
  });

  it("skips position when no next bar exists (freshly opened)", () => {
    const db = openMemoryDb();
    seedPositionWithoutNextBar(db);

    const count = restampPendingEntryFills(db);

    expect(count).toBe(0);
    db.close();
  });

  it("only restamps entry_price when stop has already moved", () => {
    const db = openMemoryDb();
    const { positionId } = seedPositionWithStopMovement(db);

    const count = restampPendingEntryFills(db);

    expect(count).toBe(1);

    const pos = db
      .prepare(`SELECT entry_price, current_stop_loss FROM positions WHERE id = ?`)
      .get(positionId) as { entry_price: number; current_stop_loss: number | null };

    // entry_price should be Monday open (101)
    expect(pos.entry_price).toBe(MONDAY_OPEN);
    // current_stop_loss should remain 93 (from stop_movements), NOT re-seeded to
    // 101 - 4*3 = 89 (which is what full restamp would produce with atr14=3)
    expect(pos.current_stop_loss).toBe(93);
    db.close();
  });

  it("is idempotent — second call is a no-op", () => {
    const db = openMemoryDb();
    seedPositionWithNextBar(db);

    const first = restampPendingEntryFills(db);
    const second = restampPendingEntryFills(db);

    expect(first).toBe(1);
    expect(second).toBe(0);
    db.close();
  });

  it("skips already-restamped positions", () => {
    const db = openMemoryDb();
    const { positionId } = seedPositionWithNextBar(db);

    // Manually set a different entry_price to simulate already restamped
    db.prepare(`UPDATE positions SET entry_price = 102 WHERE id = ?`).run(positionId);

    const count = restampPendingEntryFills(db);
    expect(count).toBe(0);
    db.close();
  });

  it("handles atr14 = null gracefully (entry-only restamp)", () => {
    const db = openMemoryDb();
    const { positionId } = seedPositionWithNextBar(db, { atr14: null as unknown as number });

    const count = restampPendingEntryFills(db);

    expect(count).toBe(1);

    const pos = db
      .prepare(`SELECT entry_price FROM positions WHERE id = ?`)
      .get(positionId) as { entry_price: number };

    // entry_price should still be restamped even without ATR
    expect(pos.entry_price).toBe(MONDAY_OPEN);
    db.close();
  });
});


