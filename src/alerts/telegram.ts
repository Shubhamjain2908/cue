import path from "node:path";
import { fileURLToPath } from "node:url";

import axios from "axios";
import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import { initSchema } from "../db/schema.js";
import { listBuySignalsReadyToAlert, markSignalAlerted, type BuyAlertPendingRow } from "../db/queries.js";

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

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
  const config = getConfig();
  const db = new Database(config.DB_PATH);
  db.pragma("foreign_keys = ON");
  try {
    initSchema(db);
    const pending = listBuySignalsReadyToAlert(db);
    if (pending.length === 0) {
      console.log("No BUY signals pending alert (enriched + not alerted).");
      return;
    }
    for (const row of pending) {
      const text = formatTelegramAlert(row);
      try {
        await sendTelegramMessage(text);
        markSignalAlerted(db, row.id);
        console.log(`Alert sent for ${row.ticker} (${row.id})`);
      } catch (e) {
        console.error(`Alert failed for ${row.ticker} (${row.id}):`, e);
      }
    }
  } finally {
    db.close();
  }
}

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
