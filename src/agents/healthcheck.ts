import axios from "axios";
import type { Logger } from "winston";

import { REBALANCE_DAY_OF_WEEK, weekdayUtcForNyCalendarDate } from "./daily-workflow.js";
import { cueLogger } from "../cli/cue-logger.js";
import type { AppConfig } from "../config/index.js";
import { CUE_LOCALE, CUE_TIME_ZONE, getExchangeDateString } from "../config/cue-timezone.js";
import { getPipelineState } from "../db/queries.js";
import type { CueDatabase } from "../db/provider.js";
import { getStaleOpenPositions } from "../briefing/queries.js";
import { resolveLastETSession } from "../ingestors/massive-price-ingestor.js";

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export type HealthcheckDeps = {
  now?: () => Date;
  sendTelegram?: (text: string) => Promise<void>;
};

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

function countQqqSessionsAfter(
  db: CueDatabase,
  fromExclusive: string,
  asOfInclusive: string,
): number {
  const rows = db
    .prepare(
      `
      SELECT date FROM daily_prices
      WHERE ticker = 'QQQ' AND date > @from AND date <= @to
      ORDER BY date ASC
    `,
    )
    .all({ from: fromExclusive, to: asOfInclusive }) as { date: string }[];
  return rows.length;
}

/** Prior Mon–Fri ET session immediately before `sessionYmd`. */
function priorEtTradingSessionYmd(sessionYmd: string): string {
  const [y, m, d] = sessionYmd.split("-").map(Number);
  let civil = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  civil.setUTCDate(civil.getUTCDate() - 1);
  for (let i = 0; i < 5; i++) {
    const yy = civil.getUTCFullYear();
    const mo = civil.getUTCMonth() + 1;
    const da = civil.getUTCDate();
    const dow = new Date(Date.UTC(yy, mo - 1, da, 12, 0, 0)).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const ys = String(yy).padStart(4, "0");
      const ms = String(mo).padStart(2, "0");
      const ds = String(da).padStart(2, "0");
      return `${ys}-${ms}-${ds}`;
    }
    civil.setUTCDate(civil.getUTCDate() - 1);
  }
  throw new Error(`priorEtTradingSessionYmd: could not resolve session before ${sessionYmd}`);
}

export function checkStalePositions(db: CueDatabase, now: Date): CheckResult {
  const name = "stale_positions";
  const asOf = resolveLastETSession(now);
  const stale = getStaleOpenPositions(db, asOf);
  if (stale.length === 0) {
    return {
      name,
      status: "PASS",
      message: `no OPEN positions with price data >3 QQQ sessions behind ${asOf}`,
    };
  }
  const detail = stale
    .map((s) =>
      s.lastPriceDate === null
        ? `${s.ticker}(no bars)`
        : `${s.ticker}(last=${s.lastPriceDate}, lag=${String(s.sessionsBehind)} sessions)`,
    )
    .join(", ");
  return {
    name,
    status: "FAIL",
    message: `orphaned OPEN positions vs asOf=${asOf}: ${detail}`,
  };
}

export function checkQqqLag(db: CueDatabase, now: Date): CheckResult {
  const name = "qqq_lag";
  const expectedSession = resolveLastETSession(now);
  const row = db
    .prepare(`SELECT MAX(date) AS d FROM daily_prices WHERE ticker = 'QQQ'`)
    .get() as { d: string | null };
  const qqqMax = row.d;

  if (qqqMax === null) {
    return {
      name,
      status: "FAIL",
      message: "QQQ has no rows in daily_prices; regime gate cannot be trusted",
    };
  }
  if (compareYmd(qqqMax, expectedSession) >= 0) {
    return {
      name,
      status: "PASS",
      message: `QQQ current to ${qqqMax} (expected ${expectedSession})`,
    };
  }

  const sessionsBehind = countQqqSessionsAfter(db, qqqMax, expectedSession);
  if (sessionsBehind > 1) {
    return {
      name,
      status: "FAIL",
      message: `QQQ stale: max=${qqqMax}, expected ${expectedSession} (${String(sessionsBehind)} sessions behind)`,
    };
  }
  if (sessionsBehind === 1 || qqqMax === priorEtTradingSessionYmd(expectedSession)) {
    return {
      name,
      status: "WARN",
      message: `QQQ lagging by 1 session: max=${qqqMax}, expected ${expectedSession} (weekend regime gate may use stale SMA)`,
    };
  }
  return {
    name,
    status: "FAIL",
    message: `QQQ stale: max=${qqqMax}, expected ${expectedSession} (regime data materially behind)`,
  };
}

export function checkIngestStaleness(db: CueDatabase): CheckResult {
  const name = "ingest_staleness";
  const staleFlag = getPipelineState(db, "last_ingest_was_stale");
  if (staleFlag === "1") {
    return {
      name,
      status: "FAIL",
      message:
        "Last ingest fell back to T-1 data already in DB — stops evaluated on stale prices",
    };
  }
  return {
    name,
    status: "PASS",
    message: "last ingest did not use stale T-1 fallback",
  };
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
    // Screener stamps signals with date = asOf (last ET trading session), not the
    // calendar run date. On Sunday rebalance, asOf is the prior Friday.
    const sessionYmd = resolveLastETSession(now);
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM signals WHERE date = @sessionYmd`)
      .get({ sessionYmd }) as { c: number };
    if (row.c > 0) {
      return {
        name,
        status: "PASS",
        message: `signals present for session ${sessionYmd}: ${row.c} rows`,
      };
    }
    // Zero-churn rebalance: top-N is already fully held, no exits triggered, and
    // WATCHLIST_BENCH_DEPTH may be 0. Accept iff screen step exited cleanly and
    // an open book exists — otherwise something genuinely failed.
    const screenExit = getPipelineState(db, "step:screen:last_exit_code");
    const openRow = db
      .prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'OPEN'`)
      .get() as { c: number };
    if (screenExit === "0" && openRow.c > 0) {
      return {
        name,
        status: "PASS",
        message: `zero-churn rebalance for session ${sessionYmd}: ${openRow.c} OPEN positions, screen exited 0`,
      };
    }
    return {
      name,
      status: "FAIL",
      message: `no signals for rebalance session ${sessionYmd} (today_et=${todayEt})`,
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

export function checkPipelineStepState(
  db: CueDatabase,
  mode: "rebalance" | "stop",
): CheckResult {
  const name = "pipeline_step_state";
  const criticalSteps =
    mode === "rebalance" ? ["ingest", "screen"] : ["ingest", "execute-stops"];

  const failures: string[] = [];

  for (const stepName of criticalSteps) {
    const exitCodeVal = getPipelineState(db, `step:${stepName}:last_exit_code`);

    if (exitCodeVal === null) {
      cueLogger.warn(
        `healthcheck: no pipeline_state entry for step:${stepName}:last_exit_code — step may not have run yet`,
      );
      continue;
    }

    if (exitCodeVal !== "0") {
      const ranAt = getPipelineState(db, `step:${stepName}:last_run_at`) ?? "unknown time";
      failures.push(`${stepName} exited ${exitCodeVal} at ${ranAt}`);
    }
  }

  if (failures.length === 0) {
    return {
      name,
      status: "PASS",
      message: "All critical steps exited 0",
    };
  }
  return {
    name,
    status: "FAIL",
    message: `Critical step failures: ${failures.join("; ")}`,
  };
}

function healthcheckModeForEtDate(todayEt: string): "rebalance" | "stop" {
  const [y, m, d] = todayEt.split("-").map(Number);
  return weekdayUtcForNyCalendarDate(y!, m!, d!) === REBALANCE_DAY_OF_WEEK ? "rebalance" : "stop";
}

function buildTelegramMessage(todayEt: string, timeEt: string, results: CheckResult[]): string {
  const failed = results.filter((r) => r.status === "FAIL");
  const warned = results.filter((r) => r.status === "WARN");
  const passedOrSkipped = results.filter((r) => r.status !== "FAIL" && r.status !== "WARN");
  const bullet = (r: CheckResult) => `• ${r.name}: ${r.message}`;

  if (failed.length === 0) {
    const header =
      warned.length > 0
        ? `⚠️ Cue healthcheck passed with warnings — ${todayEt} ${timeEt} ET`
        : `✅ Cue healthcheck passed — ${todayEt} ${timeEt} ET`;
    const lines = [header];
    if (warned.length > 0) {
      lines.push("WARNINGS:", ...warned.map(bullet));
    }
    lines.push(...passedOrSkipped.map(bullet));
    return lines.join("\n");
  }

  const lines = [
    `⚠️ Cue healthcheck FAILED — ${todayEt} ${timeEt} ET`,
    "FAILED:",
    ...failed.map(bullet),
  ];
  if (warned.length > 0) {
    lines.push("WARNINGS:", ...warned.map(bullet));
  }
  lines.push("PASSED:", ...passedOrSkipped.map(bullet));
  return lines.join("\n");
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
  const todayMode = healthcheckModeForEtDate(todayEt);
  const sendTelegram = deps.sendTelegram ?? ((text: string) => defaultSendTelegram(text, config));

  const results: CheckResult[] = [
    checkDailyPricesCurrency(db, now),
    checkIngestStaleness(db),
    checkQqqLag(db, now),
    checkStalePositions(db, now),
    checkPipelineRanToday(db, now),
    checkPipelineStepState(db, todayMode),
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
