import path from "node:path";
import { fileURLToPath } from "node:url";

import axios from "axios";
import winston from "winston";
import { z } from "zod";

import { getConfig } from "../config/index.js";
import { markSignalAlerted } from "../db/queries.js";
import { openCueDb } from "../db/provider.js";
import {
  listBuySignalsReadyToAlert,
  type BuyAlertPendingRow,
} from "./queries.js";

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

export type AlertRunMode = "rebalance" | "stop";

const alertRunModeSchema = z.enum(["rebalance", "stop"]);

const TG_MAX = 4096;
const RULE = "──────────────────────────────";

const round2 = (n: number): string => n.toFixed(2);
const round1 = (n: number): string => n.toFixed(1);

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

/** First two sentences, capped at 280 characters. */
function trimRationale(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const sentences = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [trimmed];
  let out = sentences
    .slice(0, 2)
    .join(" ")
    .trim();
  if (out.length > 280) {
    out = out.slice(0, 280).trim();
  }
  return out;
}

export function formatTelegramAlert(row: BuyAlertPendingRow): string {
  const { POSITION_SIZE_USD } = getConfig();

  const entryMid = row.price;
  const entryLo = round2(entryMid * 0.99);
  const entryHi = round2(entryMid * 1.01);
  const stop = round2(row.initialAtrStop);
  const stopPct = round1(((entryMid - row.initialAtrStop) / entryMid) * 100);
  const multiplierLabel = "4.0× ATR";
  const riskPerShare = entryMid - row.initialAtrStop;
  const target = round2(entryMid + riskPerShare);
  const shares = Math.floor(POSITION_SIZE_USD / entryMid);

  const sentiment = row.sentiment?.toUpperCase() ?? "";
  const confidence = row.confidence?.toUpperCase() ?? "";

  let header = `🟢 BUY ${row.ticker}  |  Rank #${row.momentumRank}/${row.universeRankedCount}`;
  if (sentiment || confidence) {
    const sc = [sentiment, confidence].filter((s) => s.length > 0).join(" ");
    header += `  |  ${sc}`;
  }

  const lines = [
    header,
    RULE,
    `Entry range : $${entryLo} – $${entryHi}   (±1% last close)`,
    `Stop loss   : $${stop}  (${stopPct}% | ${multiplierLabel})`,
    `1R target   : $${target}  (1:1 R-multiple above entry mid)`,
    `Position    : $${POSITION_SIZE_USD} → ~${shares} shares @ $${round2(entryMid)}`,
    RULE,
    `Sector: ${row.sector ?? "N/A"}  |  Earnings: ${row.earningsDate ?? "N/A"}`,
  ];

  const rationale = row.rationale ? trimRationale(row.rationale) : "";
  if (rationale) {
    lines.push(rationale);
  }

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

export async function runBriefAlertCli(argv: readonly string[] = process.argv): Promise<void> {
  let mode: AlertRunMode;
  try {
    mode = parseAlertModeFromArgv(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(msg);
    process.exitCode = 1;
    return;
  }

  if (mode === "stop") {
    logger.info("mode=stop — BUY alerts suppressed");
    return;
  }

  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  try {
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

async function main(): Promise<void> {
  await runBriefAlertCli(process.argv);
}

if (isMain) {
  main().catch((e) => {
    logger.error(String(e));
    process.exit(1);
  });
}
