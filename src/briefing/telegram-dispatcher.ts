import path from "node:path";
import { fileURLToPath } from "node:url";

import axios from "axios";
import winston from "winston";
import { z } from "zod";

import { getConfig } from "../config/index.js";
import { getExchangeDateString } from "../config/cue-timezone.js";
import { markSignalAlerted, markWatchlistSignalsAlerted } from "../db/queries.js";
import { openCueDb, type CueDatabase } from "../db/provider.js";
import {
  computeNextRebalanceFriday,
  getOpenPositionsWithLastClose,
  getRegimeLabel,
  listBuySignalsReadyToAlert,
  listWatchlistSignalsForBriefing,
  resolvePulseAsOfDate,
  type BuyAlertPendingRow,
} from "./queries.js";
import { formatWatchlistBench } from "./template.js";

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

export type AlertRunMode = "rebalance" | "stop";

const alertRunModeSchema = z.enum(["rebalance", "stop"]);

const TG_MAX = 4096;
const RULE = "──────────────────────────────";
const STOP_PROXIMITY_ATR_THRESHOLD = 0.5;

const round2 = (n: number): string => n.toFixed(2);
const round1 = (n: number): string => n.toFixed(1);

let portfolioFallbackWarned = false;

export function deriveBuyAlertShares(
  row: BuyAlertPendingRow,
  config: ReturnType<typeof getConfig>,
): { shares: number; positionUsd: number } {
  const entryMid = row.price;

  let shares: number;
  if (config.PORTFOLIO_VALUE_USD !== undefined) {
    const portfolio = config.PORTFOLIO_VALUE_USD;
    const riskPerShare = row.atr14 * 2;
    const rawShares = Math.floor((portfolio * 0.01) / riskPerShare);
    const capShares = Math.floor((portfolio * 0.05) / entryMid);
    shares = Math.min(rawShares, capShares);
  } else {
    if (!portfolioFallbackWarned) {
      logger.warn("PORTFOLIO_VALUE_USD not set, using fixed POSITION_SIZE_USD");
      portfolioFallbackWarned = true;
    }
    shares = Math.floor(config.POSITION_SIZE_USD / entryMid);
  }

  if (shares === 0) {
    logger.warn(`BUY alert ${row.ticker}: shares resolved to 0, flooring to 1`);
    shares = 1;
  }

  const positionUsd = Math.round(shares * entryMid);
  return { shares, positionUsd };
}

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
  const config = getConfig();
  const entryMid = row.price;
  const { shares, positionUsd } = deriveBuyAlertShares(row, config);
  const entryLo = round2(entryMid * 0.99);
  const entryHi = round2(entryMid * 1.01);
  const stop = round2(row.initialAtrStop);
  const stopPct = round1(((entryMid - row.initialAtrStop) / entryMid) * 100);
  const multiplierLabel = "4.0× ATR";
  const riskPerShare = entryMid - row.initialAtrStop;
  const target = round2(entryMid + riskPerShare);

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
    `Position    : $${positionUsd} → ~${shares} shares @ $${round2(entryMid)}`,
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

export interface DailyPulsePositionLine {
  ticker: string;
  unrealizedPct: number;
  stop: number;
  stopLabel: "BASE" | "TIGHT";
  nearStop: boolean;
}

export function formatDailyPulseMessage(opts: {
  asOf: string;
  regimeLabel: "BULLISH" | "BEARISH";
  nextFriday: string;
  maxPositions: number;
  openCount: number;
  positions: DailyPulsePositionLine[];
}): string {
  const header = `📊 Cue Daily  |  ${opts.asOf}  |  ${opts.regimeLabel}`;
  const lines = [header, RULE];

  if (opts.openCount === 0) {
    lines.push("No open positions.");
    lines.push(RULE);
    lines.push(`Next rebalance: ${opts.nextFriday}`);
  } else {
    for (const p of opts.positions) {
      const pctStr = round1(p.unrealizedPct);
      const sign = p.unrealizedPct >= 0 ? "+" : "";
      const nearStopSuffix = p.nearStop ? "  ⚠️ NEAR STOP" : "";
      lines.push(
        `${p.ticker}  ${sign}${pctStr}%  stop $${round2(p.stop)}  [${p.stopLabel}]${nearStopSuffix}`,
      );
    }
    lines.push(RULE);
    lines.push(`Open: ${opts.openCount}/${opts.maxPositions}  |  Next rebalance: ${opts.nextFriday}`);
  }

  let text = lines.join("\n");
  if (text.length > TG_MAX) {
    text = `${text.slice(0, TG_MAX - 20)}\n…(truncated)`;
  }
  return text;
}

export async function sendWatchlistBenchAlerts(
  db: CueDatabase,
  asOf: string,
): Promise<void> {
  const { WATCHLIST_BENCH_DEPTH } = getConfig();
  if (WATCHLIST_BENCH_DEPTH <= 0) {
    return;
  }
  const rows = listWatchlistSignalsForBriefing(db, asOf, WATCHLIST_BENCH_DEPTH);
  if (rows.length === 0) {
    logger.info("No WATCHLIST signals pending bench alert.");
    return;
  }
  const text = formatWatchlistBench(rows, asOf);
  await sendTelegramMessage(text);
  markWatchlistSignalsAlerted(
    db,
    rows.map((r) => r.id),
  );
  logger.info(`Watchlist bench sent (asOf=${asOf}, count=${rows.length})`);
}

export async function sendDailyPulse(db: CueDatabase): Promise<void> {
  const asOf = resolvePulseAsOfDate(db);
  if (asOf === null) {
    throw new Error("daily pulse: no QQQ rows in daily_prices — run ingest first");
  }

  const regimeLabel = getRegimeLabel(db);
  const etToday = getExchangeDateString();
  const nextFriday = computeNextRebalanceFriday(etToday);
  const { MAX_POSITIONS } = getConfig();

  const raw = getOpenPositionsWithLastClose(db, asOf);
  const positions: DailyPulsePositionLine[] = [];

  for (const row of raw) {
    if (row.last_close === null) {
      logger.warn(`daily pulse: skip ${row.ticker} — no daily_prices row for asOf=${asOf}`);
      continue;
    }
    const unrealizedPct = ((row.last_close - row.entry_price) / row.entry_price) * 100;
    const cushion = row.last_close - row.current_stop_loss;
    const nearStop =
      row.atr14 !== null &&
      cushion < row.atr14 * STOP_PROXIMITY_ATR_THRESHOLD;
    positions.push({
      ticker: row.ticker,
      unrealizedPct,
      stop: row.current_stop_loss,
      stopLabel: unrealizedPct >= 25.0 ? "TIGHT" : "BASE",
      nearStop,
    });
  }

  const text = formatDailyPulseMessage({
    asOf,
    regimeLabel,
    nextFriday,
    maxPositions: MAX_POSITIONS,
    openCount: raw.length,
    positions,
  });

  await sendTelegramMessage(text);
  logger.info(`Daily pulse sent (asOf=${asOf}, open=${raw.length}, lines=${positions.length})`);
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
    const config = getConfig();
    const db = openCueDb(config.DB_PATH);
    try {
      await sendDailyPulse(db);
    } catch (e) {
      logger.error(`Daily pulse failed: ${String(e)}`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
    return;
  }

  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  try {
    const pending = listBuySignalsReadyToAlert(db);
    if (pending.length === 0) {
      logger.info("No BUY signals pending alert (enriched + not alerted).");
    } else {
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
    }

    const asOf = resolvePulseAsOfDate(db);
    if (asOf === null) {
      logger.warn("Watchlist bench skipped — no QQQ as-of date in daily_prices");
    } else if (config.WATCHLIST_BENCH_DEPTH > 0) {
      try {
        await sendWatchlistBenchAlerts(db, asOf);
      } catch (e) {
        logger.error(`Watchlist bench failed: ${String(e)}`);
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
