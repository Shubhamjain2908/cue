/**
 * Live end-of-day screen: momentum rebalance (Friday ET) vs stop/max-hold evaluation (other days).
 * Mirrors `runBacktest` §6.2–6.3 semantics at a single as-of date (last QQQ trading day in DB).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { detectRunMode } from "../agents/daily-workflow.js";
import { cueLogger } from "../cli/cue-logger.js";
import { parseOptionalYmdFromArgv } from "../cli/ymd-arg.js";
import { getConfig } from "../config/index.js";
import {
  closePosition,
  insertPosition,
  insertSignal,
  mapLiveExitReason,
  type SignalInsert,
} from "../db/queries.js";
import { initSchema } from "../db/schema.js";
import {
  buildSignalThresholdsFromConfig,
  generateSignal,
} from "../enrichers/momentum-technical.js";
import { atr, sma } from "../enrichers/indicators.js";
import { computeTrailingStop, rankUniverse } from "./ranker.js";
import {
  DEFAULT_RANKING_CONFIG,
  type RankingConfig,
  type RankedTicker,
} from "../enrichers/momentum-types.js";

import {
  loadUniverseTickers,
  tryLoadUniverseMeta,
  universeMetaMatchesTickerCount,
} from "../universe/load-universe.js";

type SqliteConnection = InstanceType<typeof Database>;

interface DailyBar {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type ExitReason = "TRAILING_STOP" | "MAX_HOLD" | "REBALANCE_DROP";

function parseIsoUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function addCalendarDays(iso: string, days: number): string {
  const ms = parseIsoUtcMs(iso) + days * 86_400_000;
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const da = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function upperBoundInclusiveByDate(bars: readonly DailyBar[], asOf: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = bars[mid]!.date;
    if (d <= asOf) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function sliceBarsThrough(bars: readonly DailyBar[], asOf: string): DailyBar[] | null {
  const ub = upperBoundInclusiveByDate(bars, asOf);
  if (ub < 0) {
    return null;
  }
  return bars.slice(0, ub + 1);
}

function tradingDaysHeld(
  sortedDates: readonly string[],
  entryDate: string,
  asOf: string,
): number {
  let count = 0;
  for (const d of sortedDates) {
    if (d <= entryDate) {
      continue;
    }
    if (d > asOf) {
      break;
    }
    count++;
  }
  return count;
}

function loadQqqTradingDates(db: SqliteConnection, dateFrom: string, dateTo: string): string[] {
  const rows = db
    .prepare(
      `SELECT date FROM daily_prices WHERE ticker = 'QQQ' AND date >= ? AND date <= ? ORDER BY date ASC`,
    )
    .all(dateFrom, dateTo) as { date: string }[];
  return rows.map((r) => r.date);
}

function hydrateDailyPrices(
  db: SqliteConnection,
  tickers: readonly string[],
  dateFrom: string,
  dateTo: string,
): DailyBar[] {
  if (tickers.length === 0) {
    return [];
  }
  const placeholders = tickers.map(() => "?").join(", ");
  const stmt = db.prepare(`
    SELECT ticker, date, open, high, low, close, volume
    FROM daily_prices
    WHERE ticker IN (${placeholders})
      AND date >= ?
      AND date <= ?
    ORDER BY date ASC, ticker ASC
  `);
  return stmt.all(...tickers, dateFrom, dateTo) as DailyBar[];
}

function indexByTicker(rows: readonly DailyBar[]): Map<string, DailyBar[]> {
  const byTicker = new Map<string, DailyBar[]>();
  for (const row of rows) {
    const t = row.ticker.toUpperCase();
    let arr = byTicker.get(t);
    if (!arr) {
      arr = [];
      byTicker.set(t, arr);
    }
    arr.push({ ...row, ticker: t, date: row.date });
  }
  return byTicker;
}

function latestQqqDate(db: SqliteConnection): string | null {
  const row = db
    .prepare(`SELECT MAX(date) AS d FROM daily_prices WHERE ticker = 'QQQ'`)
    .get() as { d: string | null };
  return row.d;
}

/**
 * As-of date for screening: latest QQQ session in DB, or an explicit calendar date
 * that has a QQQ bar and is not after the DB's last QQQ date.
 */
function resolveScreenAsOfDate(db: SqliteConnection, explicitYmd?: string): string {
  const maxQ = latestQqqDate(db);
  if (maxQ === null) {
    throw new Error("screen: no QQQ rows in daily_prices — run ingest first");
  }
  if (explicitYmd === undefined || explicitYmd.length === 0) {
    return maxQ;
  }
  if (explicitYmd.localeCompare(maxQ) > 0) {
    throw new Error(
      `screen: --date ${explicitYmd} is after last QQQ date in DB (${maxQ})`,
    );
  }
  const row = db
    .prepare(`SELECT 1 AS x FROM daily_prices WHERE ticker = 'QQQ' AND date = ?`)
    .get(explicitYmd) as { x: number } | undefined;
  if (row === undefined) {
    throw new Error(
      `screen: no QQQ daily bar for --date=${explicitYmd} (ingest that session or pick another date)`,
    );
  }
  return explicitYmd;
}

interface OpenPositionRow {
  positionId: number;
  signalId: number;
  ticker: string;
  entryDate: string;
  entryPrice: number;
  initialAtrStop: number;
}

function listOpenPositions(db: SqliteConnection): OpenPositionRow[] {
  return db
    .prepare(
      `
    SELECT
      p.id AS positionId,
      p.signal_id AS signalId,
      sig.ticker AS ticker,
      p.entry_date AS entryDate,
      p.entry_price AS entryPrice,
      sig.initial_atr_stop AS initialAtrStop
    FROM positions p
    INNER JOIN signals sig ON sig.id = p.signal_id
    WHERE p.status = 'OPEN'
    ORDER BY sig.ticker ASC
  `,
    )
    .all() as OpenPositionRow[];
}

function replayExitReason(
  byTicker: Map<string, DailyBar[]>,
  sortedTradingDates: readonly string[],
  pos: OpenPositionRow,
  asOf: string,
  cfg: RankingConfig,
): ExitReason | null {
  const series = byTicker.get(pos.ticker);
  if (!series) {
    return null;
  }
  const entryUb = upperBoundInclusiveByDate(series, pos.entryDate);
  if (entryUb < 0) {
    return null;
  }
  const asOfUb = upperBoundInclusiveByDate(series, asOf);
  if (asOfUb < 0) {
    return null;
  }

  let currentStop = pos.initialAtrStop;
  let highestClose = Math.max(pos.entryPrice, series[entryUb]!.close);

  if (series[entryUb]!.close <= currentStop) {
    return "TRAILING_STOP";
  }

  for (let i = entryUb + 1; i <= asOfUb; i++) {
    const bar = series[i]!;
    if (bar.close <= currentStop) {
      return "TRAILING_STOP";
    }
    const slice = series.slice(0, i + 1);
    const highs = slice.map((b) => b.high);
    const lows = slice.map((b) => b.low);
    const closes = slice.map((b) => b.close);
    const atrToday = atr(highs, lows, closes, cfg.atrPeriod);
    if (atrToday === null) {
      continue;
    }
    highestClose = Math.max(highestClose, bar.close);
    currentStop = computeTrailingStop(
      currentStop,
      highestClose,
      pos.entryPrice,
      atrToday,
      cfg.atrMultiplierBase,
      cfg.atrMultiplierTight,
      cfg.atrTightenThresholdPct,
    );
  }

  if (tradingDaysHeld(sortedTradingDates, pos.entryDate, asOf) >= cfg.maxHoldDays) {
    return "MAX_HOLD";
  }
  return null;
}

/**
 * Run one screening pass for an as-of date (latest QQQ date in DB, or `options.asOf`).
 */
export interface RunLiveScreenOptions {
  /** Calendar session `YYYY-MM-DD` (must exist for QQQ in `daily_prices`). */
  readonly asOf?: string;
}

export function runLiveScreen(
  db: SqliteConnection,
  mode: "rebalance" | "stop",
  options?: RunLiveScreenOptions,
): void {
  const cfg: RankingConfig = { ...DEFAULT_RANKING_CONFIG };
  const appCfg = getConfig();
  const maxConcurrent = appCfg.MAX_POSITIONS;

  const asOf = resolveScreenAsOfDate(db, options?.asOf);
  const universe = loadUniverseTickers();
  const meta = tryLoadUniverseMeta();
  if (meta !== null && !universeMetaMatchesTickerCount(meta, universe.length)) {
    console.warn(
      `screen: universe _meta.json total_ticker_count (${String(meta.total_ticker_count)}) !== universe file length (${String(universe.length)})`,
    );
  }
  const allTickers = [...new Set([...universe, "QQQ"])].sort((a, b) => a.localeCompare(b));
  const dataFrom = addCalendarDays(asOf, -600);
  const rows = hydrateDailyPrices(db, allTickers, dataFrom, asOf);
  const byTicker = indexByTicker(rows);
  const sortedTradingDates = loadQqqTradingDates(db, dataFrom, asOf);

  const qqqSeries = byTicker.get("QQQ");
  if (!qqqSeries) {
    throw new Error("screen: QQQ series missing after hydrate");
  }
  const qqqBar = sliceBarsThrough(qqqSeries, asOf)?.at(-1);
  if (!qqqBar) {
    throw new Error(`screen: no QQQ bar on or before asOf=${asOf}`);
  }

  const dayMap = new Map<string, DailyBar>();
  for (const t of allTickers) {
    const s = byTicker.get(t);
    if (!s) {
      continue;
    }
    const ub = upperBoundInclusiveByDate(s, asOf);
    if (ub >= 0) {
      dayMap.set(t, s[ub]!);
    }
  }

  const exitReasonByTicker = new Map<string, ExitReason>();
  const openRows = listOpenPositions(db);

  for (const pos of openRows) {
    const r = replayExitReason(byTicker, sortedTradingDates, pos, asOf, cfg);
    if (r !== null) {
      exitReasonByTicker.set(pos.ticker, r);
    }
  }

  const qqqSlice = sliceBarsThrough(qqqSeries, asOf);
  const qqqCloses = qqqSlice?.map((b) => b.close) ?? [];
  const smaRegime = sma(cfg.smaPeriod, qqqCloses);
  const regimeOk = smaRegime !== null && qqqBar.close > smaRegime;

  let fullRanked: RankedTicker[] = [];

  if (mode === "rebalance" && regimeOk) {
    const priceMap = new Map<string, number[]>();
    for (const t of universe) {
      const series = byTicker.get(t);
      if (!series) {
        continue;
      }
      const slice = sliceBarsThrough(series, asOf);
      if (!slice || slice.length < cfg.lookbackDays) {
        continue;
      }
      priceMap.set(t, slice.map((b) => b.close));
    }

    fullRanked = rankUniverse(priceMap, {
      lookbackDays: cfg.lookbackDays,
      skipDays: cfg.skipDays,
      topN: cfg.topN,
    });
    const quorum = universe.length * 0.8;
    if (fullRanked.length < quorum) {
      console.warn(
        `screen: partial cross-section — ranked ${String(fullRanked.length)} of ${String(universe.length)} universe tickers (12-1 needs full history; quorum ~${String(Math.ceil(quorum))})`,
      );
    }
    const topSet = new Set(fullRanked.slice(0, cfg.topN).map((r) => r.ticker));

    for (const pos of openRows) {
      if (!topSet.has(pos.ticker) && !exitReasonByTicker.has(pos.ticker)) {
        exitReasonByTicker.set(pos.ticker, "REBALANCE_DROP");
      }
    }
  }

  const tx = db.transaction(() => {
    for (const pos of openRows) {
      const reason = exitReasonByTicker.get(pos.ticker);
      if (reason === undefined) {
        continue;
      }
      const bar = dayMap.get(pos.ticker);
      if (!bar) {
        continue;
      }
      const sellRow: SignalInsert = {
        ticker: pos.ticker,
        date: asOf,
        signal: "SELL",
        price: bar.close,
      };
      insertSignal(db, sellRow);
      closePosition(db, pos.positionId, asOf, bar.close, mapLiveExitReason(reason));
    }

    if (mode !== "rebalance" || !regimeOk) {
      return;
    }

    let openSlots = listOpenPositions(db).length;
    const rankedLen = fullRanked.length;
    for (const rankEntry of fullRanked.slice(0, cfg.topN)) {
      if (openSlots >= maxConcurrent) {
        break;
      }
      const t = rankEntry.ticker;
      const alreadyOpen = db
        .prepare(
          `
        SELECT 1 AS x FROM positions p
        INNER JOIN signals s ON s.id = p.signal_id
        WHERE p.status = 'OPEN' AND s.ticker = @ticker LIMIT 1
      `,
        )
        .get({ ticker: t }) as { x: number } | undefined;
      if (alreadyOpen !== undefined) {
        continue;
      }

      const series = byTicker.get(t);
      if (!series) {
        continue;
      }
      const slice = sliceBarsThrough(series, asOf);
      if (!slice || slice.length < cfg.lookbackDays) {
        continue;
      }
      const highs = slice.map((b) => b.high);
      const lows = slice.map((b) => b.low);
      const closes = slice.map((b) => b.close);
      const entryAtrVal = atr(highs, lows, closes, cfg.atrPeriod);
      if (entryAtrVal === null) {
        continue;
      }

      const bar = dayMap.get(t);
      if (!bar) {
        continue;
      }
      const closePx = bar.close;
      const initialStop = closePx - cfg.atrMultiplierBase * entryAtrVal;

      const buy: SignalInsert = {
        ticker: t,
        date: asOf,
        signal: "BUY",
        price: closePx,
        momentumRank: rankEntry.rank,
        universeRankedCount: rankedLen,
        momentum12_1Return: rankEntry.momentumReturn,
        atr14: entryAtrVal,
        initialAtrStop: initialStop,
      };
      const ins = insertSignal(db, buy);
      if (ins.changes === 0) {
        continue;
      }
      insertPosition(db, {
        signalId: Number(ins.lastInsertRowid),
        entryDate: asOf,
        entryPrice: closePx,
        status: "OPEN",
      });
      openSlots += 1;
    }

    const benchDepth = appCfg.WATCHLIST_BENCH_DEPTH;
    if (benchDepth > 0) {
      const benchSlice = fullRanked.slice(cfg.topN, cfg.topN + benchDepth);
      for (const rankEntry of benchSlice) {
        const t = rankEntry.ticker;
        const series = byTicker.get(t);
        if (!series) {
          continue;
        }
        const slice = sliceBarsThrough(series, asOf);
        if (!slice || slice.length < cfg.lookbackDays) {
          continue;
        }
        const highs = slice.map((b) => b.high);
        const lows = slice.map((b) => b.low);
        const closes = slice.map((b) => b.close);
        const entryAtrVal = atr(highs, lows, closes, cfg.atrPeriod);
        if (entryAtrVal === null) {
          continue;
        }
        const bar = dayMap.get(t);
        if (!bar) {
          continue;
        }
        const closePx = bar.close;
        const watch: SignalInsert = {
          ticker: t,
          date: asOf,
          signal: "WATCHLIST",
          price: closePx,
          momentumRank: rankEntry.rank,
          universeRankedCount: rankedLen,
          momentum12_1Return: rankEntry.momentumReturn,
          atr14: entryAtrVal,
        };
        const ins = insertSignal(db, watch);
        if (ins.changes > 0) {
          cueLogger.debug(`[screener] watchlist rank #${String(rankEntry.rank)} ${t}`);
        }
      }
    }
  });

  tx();

  const sells = openRows.filter((p) => exitReasonByTicker.has(p.ticker)).length;
  const baseSummary = `screen: asOf=${asOf} mode=${mode} regimeOk=${regimeOk ? "1" : "0"} sells=${sells}`;
  if (mode === "stop") {
    cueLogger.debug(
      `${baseSummary} rankedUniverse=skipped (intentional stop-mode execution; cross-sectional ranking not run)`,
    );
    cueLogger.info(baseSummary);
  } else {
    cueLogger.info(`${baseSummary} rankedUniverse=${fullRanked.length}`);
  }
}

/**
 * CLI entry: `--ticker X` prints BUY/HOLD signal; otherwise runs live momentum screen.
 * @param argv Flags only (e.g. `["--ticker","AAPL"]` or `["--force-rebalance"]`); defaults to `process.argv.slice(2)`.
 */
export function runScreenCli(argv: readonly string[] = process.argv.slice(2)): void {
  let explicitAsOf: string | undefined;
  try {
    explicitAsOf = parseOptionalYmdFromArgv(argv, "--date");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exitCode = 1;
    return;
  }

  const tIdx = argv.indexOf("--ticker");
  const raw = tIdx >= 0 ? argv[tIdx + 1] : undefined;
  if (raw !== undefined && raw.length > 0) {
    const ticker = raw.toUpperCase();
    const config = getConfig();
    const db = new Database(config.DB_PATH);
    try {
      initSchema(db);
      const rows = db
        .prepare(
          `SELECT date, close, volume FROM daily_prices WHERE ticker = ? ORDER BY date ASC`,
        )
        .all(ticker) as Array<{ date: string; close: number; volume: number }>;
      if (rows.length === 0) {
        console.log("HOLD");
        return;
      }

      let rowsThrough = rows;
      let qqqAsOf: string;
      if (explicitAsOf !== undefined) {
        qqqAsOf = resolveScreenAsOfDate(db, explicitAsOf);
        rowsThrough = rows.filter((r) => r.date <= qqqAsOf);
        if (rowsThrough.length === 0) {
          console.error(`screen: no ${ticker} bars on or before --date=${qqqAsOf}`);
          process.exitCode = 1;
          return;
        }
      } else {
        qqqAsOf = rows[rows.length - 1]!.date;
      }

      const qqqRows = db
        .prepare(
          `SELECT close FROM daily_prices WHERE ticker = 'QQQ' AND date <= ? ORDER BY date ASC`,
        )
        .all(qqqAsOf) as Array<{ close: number }>;
      if (qqqRows.length === 0) {
        console.error("QQQ not found in daily_prices — required for regime filter");
        process.exitCode = 1;
        return;
      }
      const { signal } = generateSignal({
        close: rowsThrough.map((r) => r.close),
        volume: rowsThrough.map((r) => r.volume),
        qqqCloses: qqqRows.map((r) => r.close),
        thresholds: buildSignalThresholdsFromConfig(),
        positionOpen: false,
      });
      console.log(signal === "BUY" ? "BUY" : "HOLD");
    } finally {
      db.close();
    }
  } else {
    const config = getConfig();
    const db = new Database(config.DB_PATH);
    try {
      initSchema(db);
      const mode = detectRunMode({ argv });
      runLiveScreen(db, mode, { asOf: explicitAsOf });
    } finally {
      db.close();
    }
  }
}

/** Stop-day path only: trailing stops, high-water replay, max-hold / stop-out → SELL + close (no rebalance BUYs). */
export function runExecuteStopsCli(argv: readonly string[] = process.argv.slice(2)): void {
  let explicitAsOf: string | undefined;
  try {
    explicitAsOf = parseOptionalYmdFromArgv(argv, "--date");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exitCode = 1;
    return;
  }

  const config = getConfig();
  const db = new Database(config.DB_PATH);
  try {
    initSchema(db);
    runLiveScreen(db, "stop", { asOf: explicitAsOf });
  } finally {
    db.close();
  }
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");

if (isMain) {
  runScreenCli();
}
