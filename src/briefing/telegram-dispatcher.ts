import path from "node:path";
import { fileURLToPath } from "node:url";

import axios from "axios";
import { z } from "zod";

import { createCueLogger, cueLogger } from "../cli/cue-logger.js";
import { getConfig } from "../config/index.js";
import { DEFAULT_RANKING_CONFIG } from "../enrichers/momentum-types.js";
import { formatMomentumRankLabel } from "../shared/momentum-rank-label.js";
import { loadUniverseTickers } from "../universe/load-universe.js";
import { getExchangeDateString } from "../config/cue-timezone.js";
import { markSignalAlerted, markWatchlistSignalsAlerted } from "../db/queries.js";
import { openCueDb, type CueDatabase } from "../db/provider.js";
import {
  computeNextRebalanceFriday,
  getOpenPositionsWithLastClose,
  getRegimeLabel,
  getSectorConcentrationRows,
  listBuySignalsReadyToAlert,
  listSellSignalsReadyToAlert,
  listWatchlistSignalsForBriefing,
  resolvePulseAsOfDate,
  type BuyAlertPendingRow,
  type SectorConcentrationRow,
  type SellAlertPendingRow,
} from "./queries.js";
import { TG_MAX, TG_TRUNCATE_RESERVE } from "../shared/constants.js";
import { formatWatchlistBench } from "./template.js";

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

export type AlertRunMode = "rebalance" | "stop";

const alertRunModeSchema = z.enum(["rebalance", "stop"]);
const RULE = "──────────────────────────────";
const STOP_PROXIMITY_ATR_THRESHOLD = 0.5;

/** Telegram bot API: ~1 msg/sec per chat; fixed pacing between sends. */
const TELEGRAM_MIN_INTERVAL_MS = 1100;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function sendAndMark(
  message: string,
  markAlertedFn: (() => void) | null,
): Promise<void> {
  await sendTelegramMessage(message);
  if (markAlertedFn) {
    markAlertedFn();
  }
  await sleep(TELEGRAM_MIN_INTERVAL_MS);
}

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
    const riskPerShare = row.atr14 * DEFAULT_RANKING_CONFIG.atrMultiplierBase;
    const rawShares = Math.floor((portfolio * 0.01) / riskPerShare);
    const capShares = Math.floor((portfolio * 0.05) / entryMid);
    shares = Math.min(rawShares, capShares);
  } else {
    if (!portfolioFallbackWarned) {
      logger.warn("PORTFOLIO_VALUE_USD not set, using fixed POSITION_SIZE_USD");
      portfolioFallbackWarned = true;
    }
    const impliedBookSize = config.POSITION_SIZE_USD * config.MAX_POSITIONS;
    const capShares = Math.floor((impliedBookSize * 0.05) / entryMid);
    const rawShares = Math.floor(config.POSITION_SIZE_USD / entryMid);
    shares = Math.min(rawShares, capShares);
    if (shares < rawShares) {
      cueLogger.debug(
        `sizer fallback: capped shares from ${String(rawShares)} to ${String(shares)} ` +
          `(5% cap on implied book ${String(impliedBookSize)})`,
      );
    }
  }

  if (shares === 0) {
    logger.warn(`BUY alert ${row.ticker}: shares resolved to 0 — 1 share exceeds 5% cap`);
  }

  const positionUsd = Math.round(shares * entryMid);
  return { shares, positionUsd };
}

const logger = createCueLogger("alert");

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

export function formatTelegramSellAlert(row: SellAlertPendingRow): string {
  const pnlPct = ((row.exitPrice - row.entryPrice) / row.entryPrice) * 100;
  const pnlSign = pnlPct >= 0 ? "+" : "";
  const pnlStr = `${pnlSign}${pnlPct.toFixed(2)}%`;

  const reasonLabels: Record<string, string> = {
    TRAILING_STOP: "🔴 TRAILING_STOP",
    TIME_EXIT: "⏱ TIME_EXIT",
    REBALANCE_DROP: "🔄 REBALANCE_DROP",
    MANUAL: "✋ MANUAL",
  };
  const reasonLabel = row.exitReason !== null
    ? (reasonLabels[row.exitReason] ?? row.exitReason)
    : "EXIT";

  const lines = [
    `🔴 SELL ${row.ticker}  |  ${reasonLabel}`,
    RULE,
    `Entry : $${round2(row.entryPrice)}  (${row.entryDate})`,
    `Exit  : $${round2(row.exitPrice)}  (${row.exitDate})`,
    `P&L   : ${pnlStr}`,
  ];

  let text = lines.join("\n");
  if (text.length > TG_MAX) {
        text = `${text.slice(0, TG_MAX - TG_TRUNCATE_RESERVE)}\n…(truncated)`;
  }
  return text;
}

export async function sendSellAlerts(db: CueDatabase): Promise<number> {
  const pending = listSellSignalsReadyToAlert(db);
  let sent = 0;
  for (const row of pending) {
    const text = formatTelegramSellAlert(row);
    await sendAndMark(text, () => {
      markSignalAlerted(db, row.id);
    });
    logger.info(`SELL alert sent for ${row.ticker} (signal_id=${row.id}, reason=${row.exitReason ?? "n/a"})`);
    sent++;
  }
  return sent;
}

export function formatTelegramAlert(
  row: BuyAlertPendingRow,
  sectorConcentration?: readonly SectorConcentrationRow[],
): string {
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

  const universeTotal = loadUniverseTickers().length;
  const rankLabel = formatMomentumRankLabel(row.momentumRank, row.universeRankedCount, universeTotal);

  let header = `🟢 BUY ${row.ticker}  |  Rank ${rankLabel}`;
  if (sentiment || confidence) {
    const sc = [sentiment, confidence].filter((s) => s.length > 0).join(" ");
    header += `  |  ${sc}`;
  }
  if (row.enrichmentStatus && row.enrichmentStatus !== "OK") {
    header += `  |  ⚠ ENRICHMENT_${row.enrichmentStatus}`;
  }

  const lines = [
    header,
    RULE,
  ];

  if (shares === 0) {
    // Calculate 5% cap for the skip message (reuse outer `config`)
    let capUsd: number;
    if (config.PORTFOLIO_VALUE_USD !== undefined) {
      capUsd = config.PORTFOLIO_VALUE_USD * 0.05;
    } else {
      const impliedBook = config.POSITION_SIZE_USD * config.MAX_POSITIONS;
      capUsd = impliedBook * 0.05;
    }
    lines.push(
      `Position    : SKIP — 1 share ($${round2(entryMid)}) exceeds 5% cap ($${round2(capUsd)})`,
    );
    lines.push(RULE);
    lines.push(`Sector: ${row.sector ?? "N/A"}  |  Earnings: ${row.earningsDate ?? "N/A"}`);
  } else {
    lines.push(
      `Entry range : $${entryLo} – $${entryHi}   (±1% last close)`,
      `Stop loss   : $${stop}  (${stopPct}% | ${multiplierLabel})`,
      `1R target   : $${target}  (1:1 R-multiple above entry mid)`,
      `Position    : $${positionUsd} → ~${shares} shares @ $${round2(entryMid)}`,
      RULE,
      `Sector: ${row.sector ?? "N/A"}  |  Earnings: ${row.earningsDate ?? "N/A"}`,
    );
  }

  // Phase 1: Financial Health Score advisory line
  if (row.qualityScore !== null) {
    let qualityLine = `Quality: ${row.qualityScore.toFixed(1)}/10`;
    if (row.qualityScore < 4) {
      qualityLine = `Quality: ${row.qualityScore.toFixed(1)}/10  ⚠️ LOW`;
    }
    lines.push(qualityLine);
  }

  // Phase 2: Sector concentration warning
  if (sectorConcentration && sectorConcentration.length > 0) {
    const warnings = sectorConcentration.map(
      (sc) => `${sc.sector} (${sc.count})`,
    );
    lines.push(`⚠️ Sector concentration: ${warnings.join(", ")}`);
  }

  if (row.enrichmentStatus !== "OK") {
    lines.push(`⚠️ enrichment unavailable (${row.enrichmentStatus})`);
  }

  const rationale = row.rationale ? trimRationale(row.rationale) : "";
  if (rationale) {
    lines.push(rationale);
  }

  let text = lines.join("\n");
  if (text.length > TG_MAX) {
        text = `${text.slice(0, TG_MAX - TG_TRUNCATE_RESERVE)}\n…(truncated)`;
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
  /** Phase 2: sectors with 3+ positions (advisory warning). */
  sectorConcentration?: readonly SectorConcentrationRow[];
}): string {
  const header = `📊 Cue Daily  |  ${opts.asOf}  |  ${opts.regimeLabel}`;
  const lines = [header];

  // Phase 2: Sector concentration warning between header and RULE
  if (opts.sectorConcentration && opts.sectorConcentration.length > 0) {
    const warnings = opts.sectorConcentration.map(
      (sc) => `${sc.sector} (${sc.count})`,
    );
    lines.push(`⚠️ Sector concentration: ${warnings.join(", ")}`);
  }

  lines.push(RULE);

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
        text = `${text.slice(0, TG_MAX - TG_TRUNCATE_RESERVE)}\n…(truncated)`;
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
  const signalIds = rows.map((r) => r.id);
  await sendAndMark(text, () => {
    markWatchlistSignalsAlerted(db, signalIds);
  });
  logger.info(`Watchlist bench sent (asOf=${asOf}, count=${rows.length})`);
}

export async function sendDailyPulse(db: CueDatabase, sellCount: number): Promise<void> {
  const asOf = resolvePulseAsOfDate(db);
  if (asOf === null) {
    throw new Error("daily pulse: no QQQ rows in daily_prices — run ingest first");
  }

  const raw = getOpenPositionsWithLastClose(db, asOf);
  if (raw.length === 0 && sellCount === 0) {
    cueLogger.info("Daily Pulse suppressed — no open positions and no sells fired.");
    return;
  }

  const regimeLabel = getRegimeLabel(db);
  const etToday = getExchangeDateString();
  const nextFriday = computeNextRebalanceFriday(etToday);
  const { MAX_POSITIONS } = getConfig();
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

  const sectorConcentration = getSectorConcentrationRows(db);
  const text = formatDailyPulseMessage({
    asOf,
    regimeLabel,
    nextFriday,
    maxPositions: MAX_POSITIONS,
    openCount: raw.length,
    positions,
    sectorConcentration,
  });

  await sendAndMark(text, null);
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
      const sellCount = await sendSellAlerts(db);
      if (sellCount === 0) {
        logger.info("No SELL signals pending alert.");
      }
      await sendDailyPulse(db, sellCount);
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
    // SELL exits first (rebalance drops + any carry-over stop exits)
    const sellCount = await sendSellAlerts(db);
    if (sellCount === 0) {
      logger.info("No SELL signals pending alert.");
    }

    // BUY alerts
    const pending = listBuySignalsReadyToAlert(db);
    if (pending.length === 0) {
      logger.info("No BUY signals pending alert (enriched + not alerted).");
    } else {
      const sectorConcentration = getSectorConcentrationRows(db);
      for (const row of pending) {
        const text = formatTelegramAlert(row, sectorConcentration);
        await sendAndMark(text, () => {
          markSignalAlerted(db, row.id);
        });
        logger.info(`Alert sent for ${row.ticker} (${row.id})`);
      }
    }

    const asOf = resolvePulseAsOfDate(db);
    if (asOf === null) {
      logger.warn("Watchlist bench skipped — no QQQ as-of date in daily_prices");
    } else if (config.WATCHLIST_BENCH_DEPTH > 0) {
      await sendWatchlistBenchAlerts(db, asOf);
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
