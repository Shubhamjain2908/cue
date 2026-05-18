#!/usr/bin/env tsx
/**
 * Diagnostic: counts how many tickers would emit a BUY signal on each date
 * in the backtest window, using the same logic as runner.ts but without
 * position cap or portfolio simulation. Output shows signal crowding.
 *
 * Usage:
 *   tsx scripts/diagnose_signal_crowding.ts --from 2021-01-01 --to 2025-12-31
 *
 * Reads from the same SQLite DB and config as the main backtest.
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { getConfig } from "../src/config/index.js";
import { initSchema } from "../src/db/schema.js";
import { generateSignal } from "../src/strategy/signals.js";
import type { SignalThresholds } from "../src/strategy/types.js";

const universeSchema = z.object({ tickers: z.array(z.string().min(1)) });

interface DailyBar {
    ticker: string;
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

function parseArgs(): { from: string; to: string } {
    let from = "2021-01-01";
    let to   = "2025-12-31";
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--from" && argv[i + 1]) from = argv[++i]!;
        if (argv[i] === "--to"   && argv[i + 1]) to   = argv[++i]!;
    }
    return { from, to };
}

function loadTickers(): string[] {
    const { UNIVERSE } = getConfig();
    const raw = fs.readFileSync(
        path.join(process.cwd(), "data", "universe", `${UNIVERSE}.json`), "utf8"
    );
    return universeSchema.parse(JSON.parse(raw)).tickers.map(t => t.toUpperCase());
}

function addDays(iso: string, n: number): string {
    const ms = Date.UTC(...(iso.split("-").map(Number) as [number, number, number])
        .map((v, i) => i === 1 ? v - 1 : v) as [number, number, number]) + n * 86_400_000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

function main() {
    const { from, to } = parseArgs();
    const config = getConfig();

    const thresholds: SignalThresholds = {
        smaPeriod:        config.smaPeriod,
        buyRsiMax:        config.buyRsiMax,
        buyVolumeRatio:   config.buyVolumeRatio,
        exitRsiThreshold: config.exitRsiThreshold,
        stopLossPct:      config.stopLossPct,
        maxHoldDays:      config.maxHoldDays,
    };

    const db = new Database(config.DB_PATH);
    initSchema(db);

    const tickers = loadTickers();
    const dataFrom = addDays(from, -200);

    const rows = db.prepare(`
    SELECT ticker, date, open, high, low, close, volume
    FROM daily_prices
    WHERE ticker IN (${tickers.map(() => "?").join(",")})
      AND date >= ? AND date <= ?
    ORDER BY date ASC, ticker ASC
  `).all(...tickers, dataFrom, to) as DailyBar[];

    // Index by ticker
    const byTicker = new Map<string, DailyBar[]>();
    for (const row of rows) {
        let arr = byTicker.get(row.ticker);
        if (!arr) { arr = []; byTicker.set(row.ticker, arr); }
        arr.push(row);
    }

    // Get sorted trading dates within the signal window
    const allDates = [...new Set(rows.map(r => r.date))]
        .filter(d => d >= from && d <= to)
        .sort();

    // Binary search upper bound
    function ubInclusive(bars: DailyBar[], asOf: string): number {
        let lo = 0, hi = bars.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (bars[mid]!.date <= asOf) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return ans;
    }

    // Count signals per date
    const crowding: Array<{ date: string; count: number; tickers: string[] }> = [];

    for (const date of allDates) {
        const hits: string[] = [];
        for (const ticker of tickers) {
            const series = byTicker.get(ticker);
            if (!series) continue;
            const ub = ubInclusive(series, date);
            if (ub < 0) continue;
            const slice = series.slice(0, ub + 1);
            const { signal } = generateSignal({
                close:  slice.map(b => b.close),
                volume: slice.map(b => b.volume),
                thresholds,
            });
            if (signal === "BUY") hits.push(ticker);
        }
        if (hits.length > 0) crowding.push({ date, count: hits.length, tickers: hits });
    }

    db.close();

    if (crowding.length === 0) {
        console.log("No BUY signals fired in this window with current thresholds.");
        return;
    }

    // Summary stats
    const counts = crowding.map(c => c.count);
    const total  = crowding.length;
    const max    = Math.max(...counts);
    const avg    = counts.reduce((a, b) => a + b, 0) / total;
    const over5  = crowding.filter(c => c.count > 5).length;

    console.log("\n=== Signal Crowding Diagnostic ===");
    console.log(`Window          : ${from} → ${to}`);
    console.log(`Days with BUY≥1 : ${total}`);
    console.log(`Max signals/day : ${max}`);
    console.log(`Avg signals/day : ${avg.toFixed(1)}`);
    console.log(`Days with >5    : ${over5} (${((over5/total)*100).toFixed(1)}% — these overflow the position cap)`);

    console.log("\n--- Top 15 most crowded days ---");
    crowding
        .sort((a, b) => b.count - a.count)
        .slice(0, 15)
        .forEach(({ date, count, tickers: t }) => {
            console.log(`${date}  ${String(count).padStart(3)} signals  [${t.slice(0, 8).join(", ")}${t.length > 8 ? ` +${t.length - 8} more` : ""}]`);
        });

    console.log("\n--- Distribution ---");
    const buckets = [1, 2, 3, 5, 10, 20, 50, Infinity];
    let prev = 0;
    for (const b of buckets) {
        const label = b === Infinity ? `>${prev}` : prev === 0 ? `1` : `${prev+1}–${b}`;
        const n = crowding.filter(c => c.count > prev && c.count <= b).length;
        if (n > 0) console.log(`  signals/day ${String(label).padEnd(8)}: ${n} days`);
        prev = b;
    }
}

main();