import fs from "node:fs";
import path from "node:path";

import axios from "axios";
import type { Logger } from "winston";

import { REBALANCE_DAY_OF_WEEK, weekdayUtcForNyCalendarDate } from "./daily-workflow.js";
import type { AppConfig } from "../config/index.js";
import { CUE_LOCALE, CUE_TIME_ZONE, getExchangeDateString } from "../config/cue-timezone.js";
import type { CueDatabase } from "../db/provider.js";
import { resolveLastETSession } from "../ingestors/massive-price-ingestor.js";

export type CheckStatus = "PASS" | "FAIL" | "SKIP";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export type HealthcheckDeps = {
  now?: () => Date;
  sendTelegram?: (text: string) => Promise<void>;
  resolveLogPath?: () => string;
  readLogTail?: (logPath: string, maxLines: number) => string[];
};

const LOG_TAIL_LINES = 100;
const LOG_ERROR_LOOKBACK_MS = 90 * 60 * 1000;

const LOG_TIMESTAMP_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)/;
const LOG_ERROR_LEVEL_RE = /\serror:\s/i;

/** Align with `deploy/ecosystem.config.cjs` `error_file` for the `cue` app. */
export function resolveDefaultPm2ErrorLogPath(projectRoot = process.cwd()): string {
  return path.join(projectRoot, "logs", "pm2-cue.log");
}

function formatEtTime(now: Date): string {
  const dtf = new Intl.DateTimeFormat(CUE_LOCALE, {
    timeZone: CUE_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  let hour = "00";
  let minute = "00";
  for (const p of parts) {
    if (p.type === "hour") {
      hour = p.value;
    }
    if (p.type === "minute") {
      minute = p.value;
    }
  }
  return `${hour}:${minute}`;
}

function compareYmd(a: string, b: string): number {
  return a.localeCompare(b);
}

export function checkDailyPricesCurrency(db: CueDatabase, now: Date): CheckResult {
  const name = "ingest";
  const expectedSession = resolveLastETSession(now);
  const row = db.prepare(`SELECT MAX(date) AS d FROM daily_prices`).get() as { d: string | null };
  const actualMax = row.d;

  if (actualMax === null) {
    return {
      name,
      status: "FAIL",
      message: `daily_prices is empty; expected session ${expectedSession}`,
    };
  }
  if (compareYmd(actualMax, expectedSession) < 0) {
    return {
      name,
      status: "FAIL",
      message: `daily_prices stale: max=${actualMax}, expected >= ${expectedSession}`,
    };
  }
  return {
    name,
    status: "PASS",
    message: `daily_prices current to ${actualMax}`,
  };
}

export function checkPipelineRanToday(db: CueDatabase, now: Date): CheckResult {
  const name = "pipeline";
  const todayEt = getExchangeDateString(now);
  const [y, m, d] = todayEt.split("-").map(Number);
  const isRebalanceDay = weekdayUtcForNyCalendarDate(y!, m!, d!) === REBALANCE_DAY_OF_WEEK;

  if (isRebalanceDay) {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM signals WHERE date = @todayEt`)
      .get({ todayEt }) as { c: number };
    if (row.c === 0) {
      return {
        name,
        status: "FAIL",
        message: `no signals for rebalance session ${todayEt}`,
      };
    }
    return {
      name,
      status: "PASS",
      message: `signals present for ${todayEt}: ${row.c} rows`,
    };
  }

  const openRow = db.prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'OPEN'`).get() as {
    c: number;
  };
  const closedRow = db
    .prepare(
      `
      SELECT COUNT(*) AS c FROM positions
      WHERE exit_date = @todayEt
        AND exit_reason != 'REBALANCE_DROP'
    `,
    )
    .get({ todayEt }) as { c: number };

  if (openRow.c === 0 && closedRow.c === 0) {
    return {
      name,
      status: "FAIL",
      message: `no open positions and no strategy exits on ${todayEt}`,
    };
  }
  return {
    name,
    status: "PASS",
    message: `stop evaluation confirmed: ${openRow.c} open, ${closedRow.c} closed today`,
  };
}

function readLogTailFromDisk(logPath: string, maxLines: number): string[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const raw = fs.readFileSync(logPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-maxLines);
}

export function parseRecentErrorLogLines(lines: string[], nowMs: number): string[] {
  const cutoff = nowMs - LOG_ERROR_LOOKBACK_MS;
  const errors: string[] = [];
  for (const line of lines) {
    if (!LOG_ERROR_LEVEL_RE.test(line)) {
      continue;
    }
    const match = line.match(LOG_TIMESTAMP_RE);
    if (match === null) {
      continue;
    }
    const ts = Date.parse(match[1]!);
    if (Number.isNaN(ts) || ts < cutoff) {
      continue;
    }
    errors.push(line);
  }
  return errors;
}

export function checkPm2Logs(
  logPath: string,
  now: Date,
  readLogTail: (path: string, maxLines: number) => string[] = readLogTailFromDisk,
  logger?: Logger,
): CheckResult {
  const name = "pm2_logs";

  if (!fs.existsSync(logPath)) {
    logger?.warn(`[healthcheck] Log file missing, skipping PM2 scan: ${logPath}`);
    return {
      name,
      status: "SKIP",
      message: `log file not found (${logPath})`,
    };
  }

  const lines = readLogTail(logPath, LOG_TAIL_LINES);
  const recentErrors = parseRecentErrorLogLines(lines, now.getTime());
  if (recentErrors.length > 0) {
    const preview = recentErrors.slice(0, 3).join("\n");
    return {
      name,
      status: "FAIL",
      message: `${recentErrors.length} error-level log entries in last 90 minutes:\n${preview}`,
    };
  }
  return {
    name,
    status: "PASS",
    message: "no error-level log entries in last 90 minutes",
  };
}

function buildTelegramMessage(todayEt: string, timeEt: string, results: CheckResult[]): string {
  const failed = results.filter((r) => r.status === "FAIL");
  const passedOrSkipped = results.filter((r) => r.status !== "FAIL");
  const bullet = (r: CheckResult) => `• ${r.name}: ${r.message}`;

  if (failed.length === 0) {
    return [
      `✅ Cue healthcheck passed — ${todayEt} ${timeEt} ET`,
      ...passedOrSkipped.map(bullet),
    ].join("\n");
  }

  return [
    `⚠️ Cue healthcheck FAILED — ${todayEt} ${timeEt} ET`,
    "FAILED:",
    ...failed.map(bullet),
    "PASSED:",
    ...passedOrSkipped.map(bullet),
  ].join("\n");
}

async function defaultSendTelegram(text: string, config: AppConfig): Promise<void> {
  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await axios.post(
    url,
    {
      chat_id: config.TELEGRAM_CHAT_ID,
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

/**
 * Post-pipeline health verification. Returns 0 when all checks pass/skip, 1 on any failure
 * or Telegram delivery failure.
 */
export async function runHealthcheck(
  db: CueDatabase,
  config: AppConfig,
  logger: Logger,
  deps: HealthcheckDeps = {},
): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const todayEt = getExchangeDateString(now);
  const timeEt = formatEtTime(now);
  const logPath = deps.resolveLogPath?.() ?? resolveDefaultPm2ErrorLogPath();
  const sendTelegram = deps.sendTelegram ?? ((text: string) => defaultSendTelegram(text, config));

  const results: CheckResult[] = [
    checkDailyPricesCurrency(db, now),
    checkPipelineRanToday(db, now),
    checkPm2Logs(logPath, now, deps.readLogTail, logger),
  ];

  const hasFailure = results.some((r) => r.status === "FAIL");
  const text = buildTelegramMessage(todayEt, timeEt, results);

  try {
    await sendTelegram(text);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[healthcheck] Telegram delivery failed: ${msg}`);
    logger.error(`[healthcheck] Telegram delivery failed: ${msg}`);
    return 1;
  }

  for (const r of results) {
    logger.info(`[healthcheck] ${r.status} ${r.name}: ${r.message}`);
  }

  if (hasFailure) {
    return 1;
  }
  return 0;
}
