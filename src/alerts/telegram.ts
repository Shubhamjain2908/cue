import path from "node:path";
import { fileURLToPath } from "node:url";

import axios from "axios";
import Database from "better-sqlite3";
import winston from "winston";
import { z } from "zod";

import { getConfig } from "../config/index.js";
import { initSchema } from "../db/schema.js";
import { listBuySignalsReadyToAlert, markSignalAlerted, type BuyAlertPendingRow } from "../db/queries.js";

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

export type AlertRunMode = "rebalance" | "stop";

const alertRunModeSchema = z.enum(["rebalance", "stop"]);

const logger = winston.createLogger({
  defaultMeta: { service: "alert" },
  level: process.env.LOG_LEVEL ?? "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => {
      const { timestamp, level, message, service, ...rest } = info;
      const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
      return `${String(timestamp)} ${String(service ?? "alert")} ${level}: ${String(message)}${extra}`;
    }),
  ),
  transports: [new winston.transports.Console({ stderrLevels: ["error"] })],
});

/**
 * Reads `--mode rebalance|stop` from argv (same values as pipeline `detectRunMode`).
 * Throws if `--mode` is missing, has no value, or the value is not in the schema.
 */
export function parseAlertModeFromArgv(argv: readonly string[]): AlertRunMode {
  const idx = argv.indexOf("--mode");
  const next = idx !== -1 ? argv[idx + 1] : undefined;
  if (idx === -1 || next === undefined || next.trim() === "") {
    throw new Error("missing or empty --mode <rebalance|stop>");
  }
  const parsed = alertRunModeSchema.safeParse(next.trim().toLowerCase());
  if (!parsed.success) {
    throw new Error(`invalid --mode: ${JSON.stringify(next)} (expected rebalance or stop)`);
  }
  return parsed.data;
}

const TG_MAX = 4096;

export function formatTelegramAlert(row: BuyAlertPendingRow): string {
  const lines = [
    `Cue — BUY ${row.ticker}`,
    `Signal date: ${row.date}`,
    `Entry / last: ${row.price}`,
    `Initial ATR stop: ${row.initialAtrStop}`,
    `Rank: #${row.momentumRank} of ${row.universeRankedCount}`,
    `Sentiment: ${row.sentiment} (${row.confidence})`,
    row.earningsDate ? `Earnings (model): ${row.earningsDate}` : "Earnings (model): n/a",
    row.sector ? `Sector: ${row.sector}` : "",
    "",
    row.rationale.trim(),
  ].filter((l) => l.length > 0);
  let text = lines.join("\n");
  if (text.length > TG_MAX) {
    text = `${text.slice(0, TG_MAX - 20)}\n…(truncated)`;
  }
  return text;
}

async function sendTelegramMessage(text: string): Promise<void> {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = getConfig();
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await axios.post(
    url,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    },
    {
      headers: { "content-type": "application/json" },
      timeout: 60_000,
      validateStatus: () => true,
    },
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
}

async function main(): Promise<void> {
  let mode: AlertRunMode;
  try {
    mode = parseAlertModeFromArgv(process.argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(msg);
    process.exit(1);
  }

  if (mode === "stop") {
    logger.info("mode=stop — BUY alerts suppressed");
    return;
  }

  const config = getConfig();
  const db = new Database(config.DB_PATH);
  db.pragma("foreign_keys = ON");
  try {
    initSchema(db);
    const pending = listBuySignalsReadyToAlert(db);
    if (pending.length === 0) {
      logger.info("No BUY signals pending alert (enriched + not alerted).");
      return;
    }
    for (const row of pending) {
      const text = formatTelegramAlert(row);
      try {
        await sendTelegramMessage(text);
        markSignalAlerted(db, row.id);
        logger.info(`Alert sent for ${row.ticker} (${row.id})`);
      } catch (e) {
        logger.error(`Alert failed for ${row.ticker} (${row.id}): ${String(e)}`);
      }
    }
  } finally {
    db.close();
  }
}

if (isMain) {
  main().catch((e) => {
    logger.error(String(e));
    process.exit(1);
  });
}
