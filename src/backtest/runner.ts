import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import type { BacktestTradeExitReasonDb } from "../db/queries.js";
import {
  addCalendarDays,
  calendarYearFraction,
  compareIsoDate,
  isoWeekdayMon1ToFri5,
} from "../shared/date-utils.js";
import {
  closeMarkAsOf,
  hydrateDailyPrices,
  indexByDate,
  indexByTicker,
  loadQqqTradingDates,
  sliceBarsThrough,
} from "../shared/market-data-utils.js";
import { insertBacktestRun, insertBacktestTrade } from "../db/queries.js";
import { initSchema } from "../db/schema.js";
import { computeTrailingStop, rankUniverse } from "../analysers/ranker.js";
import { atr, sma } from "../enrichers/indicators.js";
import { DEFAULT_RANKING_CONFIG, type RankingConfig } from "../enrichers/momentum-types.js";
import {
  aggregateExitBuckets,
  benchmarkBuyHoldCagrPct,
  computeBacktestMetrics,
  printBacktestSummary,
  toBacktestExitReason,
  type BacktestStrategyExitReason,
  type SimPosition,
} from "./metrics.js";
import { openCueDb } from "../db/provider.js";
import type {
  ClosedBacktestTrade,
  EquityPoint,
  MomentumBacktestOptions,
  RunBacktestResult,
  VixRegimeGate,
} from "./types.js";
import {
  BACKTEST_INITIAL_CASH_USD,
  BACKTEST_MAX_CONCURRENT_POSITIONS,
  BACKTEST_SLIPPAGE_BUY_MULTIPLIER,
  BACKTEST_SLIPPAGE_SELL_MULTIPLIER,
  BACKTEST_POSITION_USD,
  BACKTEST_SETTLEMENT_EXTENSION_CALENDAR_DAYS,
  BACKTEST_WARMUP_CALENDAR_DAYS,
} from "./types.js";
import { loadUniverseTickers } from "../universe/load-universe.js";
import { computeFinancialHealthScore, type QualityInputFinancials, type SectorFinancialMedians } from "../analysers/signal-quality.js";
import {
  printQualityGarpSummary,
  runQualityGarpBacktest,
} from "./strategies/quality-garp.js";

type SqliteConnection = InstanceType<typeof Database>;

export const BACKTEST_BENCHMARK_TICKER = "QQQ";



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



function mean(nums: readonly number[]): number | null {
  if (nums.length === 0) {
    return null;
  }
  let s = 0;
  for (const n of nums) {
    s += n;
  }
  return s / nums.length;
}


function rankingConfigFromDefaults(): RankingConfig {
  return { ...DEFAULT_RANKING_CONFIG };
}

/**
 * P7-G stacked gate: allow new BUYs when VIX close <= ceiling.
 * Missing ^VIX session → gate OPEN (warn, do not throw).
 */
export function allowNewBuysForVixSession(sessionDate: string, vixGate?: VixRegimeGate): boolean {
  if (vixGate === undefined) {
    return true;
  }
  const vixClose = vixGate.vixByDate.get(sessionDate);
  if (vixClose === undefined) {
    console.warn(
      `runBacktest: no ^VIX close for session ${sessionDate}; VIX gate OPEN (allow BUYs)`,
    );
    return true;
  }
  return vixClose <= vixGate.maxVix;
}

/**
 * Weekly rebalance cross-sectional momentum (§6.2) with ATR trailing stops (§6.3).
 */
export function runBacktest(
  db: SqliteConnection,
  fromDate: string,
  toDate: string,
  options?: MomentumBacktestOptions,
): RunBacktestResult {
  if (compareIsoDate(fromDate, toDate) > 0) {
    throw new Error(`runBacktest: fromDate ${fromDate} is after toDate ${toDate}`);
  }

  const cfg = rankingConfigFromDefaults();
  const appCfg = getConfig();
  const positionUsd = appCfg.POSITION_SIZE_USD ?? BACKTEST_POSITION_USD;

  const universe = loadUniverseTickers();
  const allTickers = [...new Set([...universe, BACKTEST_BENCHMARK_TICKER])].sort((a, b) =>
    a.localeCompare(b),
  );

  const dataFrom = addCalendarDays(fromDate, -BACKTEST_WARMUP_CALENDAR_DAYS);
  const dataTo = addCalendarDays(toDate, BACKTEST_SETTLEMENT_EXTENSION_CALENDAR_DAYS);
  const rows = hydrateDailyPrices(db, allTickers, dataFrom, dataTo);
  if (rows.length === 0) {
    const span = db
      .prepare(`SELECT MIN(date) AS lo, MAX(date) AS hi FROM daily_prices`)
      .get() as { lo: string | null; hi: string | null };
    console.warn(
      [
        "Backtest: hydrated 0 OHLCV rows (nothing to simulate).",
        `Requested hydrate window: ${dataFrom} → ${dataTo} (warmup + settlement padding).`,
        span.lo && span.hi
          ? `Table daily_prices overall: ${span.lo} → ${span.hi}.`
          : "Table daily_prices is empty.",
        "Align --from/--to with loaded data, or run fetch for that range.",
      ].join("\n"),
    );
  }

  const byTicker = indexByTicker(rows);
  const byDate = indexByDate(rows);
  const sortedTradingDates = loadQqqTradingDates(db, dataFrom, dataTo);

  const qqqSeries = byTicker.get(BACKTEST_BENCHMARK_TICKER);
  if (!qqqSeries) {
    throw new Error("QQQ not found in daily_prices — required for calendar and regime filter");
  }
  const qqqBars = qqqSeries;
  const yearFraction = calendarYearFraction(fromDate, toDate);
  const benchmarkCagrPct = benchmarkBuyHoldCagrPct(qqqBars, fromDate, toDate);

  let cash = BACKTEST_INITIAL_CASH_USD;
  const positions = new Map<string, SimPosition>();
  const pendingExitReason = new Map<string, BacktestStrategyExitReason>();
  const pendingBuys = new Map<string, { entryAtr: number }>();

  const equityPoints: EquityPoint[] = [];
  const closedTrades: ClosedBacktestTrade[] = [];

  const exitBuckets: Record<BacktestStrategyExitReason, number> = {
    TRAILING_STOP: 0,
    MAX_HOLD: 0,
    REBALANCE_DROP: 0,
    FORCED_CLOSE: 0,
  };

  const datesLeqTo = sortedTradingDates.filter((d) => compareIsoDate(d, toDate) <= 0);
  const finalBacktestDate =
    datesLeqTo.length > 0 ? datesLeqTo[datesLeqTo.length - 1]! : null;

  const closePosition = (
    ticker: string,
    pos: SimPosition,
    exitDate: string,
    exitFillPrice: number,
    reason: BacktestStrategyExitReason,
  ): void => {
    const proceeds = pos.shares * exitFillPrice;
    cash += proceeds;
    const costBasis = pos.shares * pos.entryFillPrice;
    closedTrades.push({
      ticker,
      entryDate: pos.entryDate,
      exitDate,
      realizedPnlUsd: proceeds - costBasis,
      exitReason: toBacktestExitReason(reason),
      entryFillPrice: pos.entryFillPrice,
      exitFillPrice,
    });
    exitBuckets[reason] += 1;
    positions.delete(ticker);
    pendingExitReason.delete(ticker);
  };

  for (let di = 0; di < sortedTradingDates.length; di++) {
    const date = sortedTradingDates[di]!;
    const dayMap = byDate.get(date);
    if (!dayMap) {
      continue;
    }

    if (di > 0) {
      const tickersToTouch = new Set<string>([...positions.keys(), ...pendingExitReason.keys()]);
      for (const t of pendingBuys.keys()) {
        tickersToTouch.add(t);
      }
      const sortedTouch = [...tickersToTouch].sort((a, b) => a.localeCompare(b));

      for (const ticker of sortedTouch) {
        const exitReason = pendingExitReason.get(ticker);
        const pos = positions.get(ticker);
        if (exitReason !== undefined && pos !== undefined) {
          const bar = dayMap.get(ticker);
          if (!bar) {
            continue;
          }
          const exitFill = bar.open * BACKTEST_SLIPPAGE_SELL_MULTIPLIER;
          closePosition(ticker, pos, date, exitFill, exitReason);
        }
      }

      const buyOrder = [...pendingBuys.keys()].sort((a, b) => a.localeCompare(b));
      for (const ticker of buyOrder) {
        if (positions.size >= BACKTEST_MAX_CONCURRENT_POSITIONS) {
          break;
        }
        if (positions.has(ticker)) {
          pendingBuys.delete(ticker);
          continue;
        }
        const meta = pendingBuys.get(ticker);
        if (!meta) {
          continue;
        }
        const bar = dayMap.get(ticker);
        if (!bar) {
          continue;
        }
        const buyFill = bar.open * BACKTEST_SLIPPAGE_BUY_MULTIPLIER;
        if (cash < positionUsd) {
          continue;
        }
        const shares = positionUsd / buyFill;
        const cost = shares * buyFill;
        if (cost > cash + 1e-6) {
          continue;
        }
        cash -= cost;
        const initialStop = buyFill - cfg.atrMultiplierBase * meta.entryAtr;
        positions.set(ticker, {
          entryDate: date,
          entryFillPrice: buyFill,
          shares,
          entryAtr: meta.entryAtr,
          currentStop: initialStop,
          highestCloseSinceEntry: Math.max(buyFill, bar.close),
        });
        pendingBuys.delete(ticker);
      }
    }

    const qqqBar = dayMap.get(BACKTEST_BENCHMARK_TICKER);
    if (qqqBar) {
      for (const [ticker, pos] of [...positions.entries()]) {
        const bar = dayMap.get(ticker);
        if (!bar) {
          continue;
        }
        if (bar.close <= pos.currentStop && !pendingExitReason.has(ticker)) {
          pendingExitReason.set(ticker, "TRAILING_STOP");
        }
      }
    }

    const inSignalWindow =
      compareIsoDate(date, fromDate) >= 0 && compareIsoDate(date, toDate) <= 0;

    const dow = isoWeekdayMon1ToFri5(date);
    const isRebalance = dow === cfg.rebalanceDayOfWeek;
    if (isRebalance && qqqBar && inSignalWindow) {
      const qqqSlice = sliceBarsThrough(qqqBars, date);
      const qqqCloses = qqqSlice?.map((b) => b.close) ?? [];
      const smaRegime = sma(cfg.smaPeriod, qqqCloses);
      const qqqRegimeOk = smaRegime !== null && qqqBar.close > smaRegime;

      if (qqqRegimeOk) {
        const priceMap = new Map<string, number[]>();
        for (const t of universe) {
          const series = byTicker.get(t);
          if (!series) {
            continue;
          }
          const slice = sliceBarsThrough(series, date);
          if (!slice || slice.length < cfg.lookbackDays) {
            continue;
          }
          priceMap.set(t, slice.map((b) => b.close));
        }

        const ranked = rankUniverse(priceMap, {
          lookbackDays: cfg.lookbackDays,
          skipDays: cfg.skipDays,
          topN: cfg.topN,
        });
        const topSet = new Set(ranked.slice(0, cfg.topN).map((r) => r.ticker));

        for (const [ticker] of [...positions.entries()]) {
          if (!topSet.has(ticker) && !pendingExitReason.has(ticker)) {
            pendingExitReason.set(ticker, "REBALANCE_DROP");
          }
        }

        const allowNewBuys = allowNewBuysForVixSession(date, options?.vixGate);
        if (allowNewBuys) {
          // Phase 3: quality floor filter — skip tickers below threshold
          const qualityFloor = options?.qualityFloor;
          const qualityByTicker = options?.qualityByTicker;

          for (const t of ranked.slice(0, cfg.topN)) {
            if (positions.size + pendingBuys.size >= BACKTEST_MAX_CONCURRENT_POSITIONS) {
              break;
            }
            if (positions.has(t.ticker) || pendingBuys.has(t.ticker)) {
              continue;
            }
            // Apply quality floor if configured
            if (qualityFloor !== undefined && qualityByTicker !== undefined) {
              const score = qualityByTicker.get(t.ticker);
              if (score === undefined || score < qualityFloor) {
                continue;
              }
            }
            const series = byTicker.get(t.ticker);
            if (!series) {
              continue;
            }
            const slice = sliceBarsThrough(series, date);
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
            pendingBuys.set(t.ticker, { entryAtr: entryAtrVal });
          }
        }
      }
    }

    for (const [ticker, pos] of [...positions.entries()]) {
      const bar = dayMap.get(ticker);
      if (!bar) {
        continue;
      }
      const nextHigh = Math.max(pos.highestCloseSinceEntry, bar.close);
      const series = byTicker.get(ticker);
      const slice = series ? sliceBarsThrough(series, date) : null;
      if (!slice || slice.length === 0) {
        continue;
      }
      const highs = slice.map((b) => b.high);
      const lows = slice.map((b) => b.low);
      const closes = slice.map((b) => b.close);
      const atrToday = atr(highs, lows, closes, cfg.atrPeriod);
      if (atrToday === null) {
        continue;
      }
      const newStop = computeTrailingStop(
        pos.currentStop,
        nextHigh,
        pos.entryFillPrice,
        atrToday,
        cfg.atrMultiplierBase,
        cfg.atrMultiplierTight,
        cfg.atrTightenThresholdPct,
      );
      positions.set(ticker, {
        ...pos,
        highestCloseSinceEntry: nextHigh,
        currentStop: newStop,
      });
    }

    for (const [ticker, pos] of [...positions.entries()]) {
      if (tradingDaysHeld(sortedTradingDates, pos.entryDate, date) >= cfg.maxHoldDays) {
        if (!pendingExitReason.has(ticker)) {
          pendingExitReason.set(ticker, "MAX_HOLD");
        }
      }
    }

    if (finalBacktestDate !== null && date === finalBacktestDate) {
      for (const [ticker, pos] of [...positions.entries()]) {
        const bar = dayMap.get(ticker);
        if (!bar) {
          continue;
        }
        const exitFill = bar.close * BACKTEST_SLIPPAGE_SELL_MULTIPLIER;
        closePosition(ticker, pos, date, exitFill, "FORCED_CLOSE");
      }
    }

    if (inSignalWindow) {
      let mtm = cash;
      for (const [ticker, pos] of positions) {
        const series = byTicker.get(ticker);
        if (!series) {
          continue;
        }
        const px = closeMarkAsOf(series, date);
        if (px === null) {
          continue;
        }
        mtm += pos.shares * px;
      }
      equityPoints.push({ date, equityUsd: mtm });
    }
  }

  const metrics = computeBacktestMetrics({
    equityPoints,
    closedTrades,
    yearFraction,
  });

  return { equityPoints, closedTrades, metrics, benchmarkCagrPct, yearFraction };
}

/** Median of an array of finite numbers (null if empty). */
function median(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Extract financial metrics from a fundamentals_cache payload JSON string. */
function extractFinancialsFromPayload(
  payloadJson: string,
): { fin: QualityInputFinancials; sector: string | null } | null {
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    const yahoo = parsed.yahoo as Record<string, unknown> | undefined;
    if (!yahoo || typeof yahoo !== "object") return null;
    const financials = yahoo.financials as Record<string, unknown> | undefined;
    if (!financials || typeof financials !== "object") return null;

    const fin: QualityInputFinancials = {
      trailingPE: (financials.trailingPE as number | null) ?? null,
      returnOnEquity: (financials.returnOnEquity as number | null) ?? null,
      debtToEquity: (financials.debtToEquity as number | null) ?? null,
      returnOnAssets: (financials.returnOnAssets as number | null) ?? null,
      grossMargins: (financials.grossMargins as number | null) ?? null,
      operatingMargins: (financials.operatingMargins as number | null) ?? null,
      profitMargins: (financials.profitMargins as number | null) ?? null,
      operatingCashflow: (financials.operatingCashflow as number | null) ?? null,
      freeCashflow: (financials.freeCashflow as number | null) ?? null,
      currentRatio: (financials.currentRatio as number | null) ?? null,
      priceToSalesTrailing12Months: (financials.priceToSalesTrailing12Months as number | null) ?? null,
      forwardPE: (financials.forwardPE as number | null) ?? null,
      priceToBook: (financials.priceToBook as number | null) ?? null,
      earningsGrowth: (financials.earningsGrowth as number | null) ?? null,
      revenueGrowth: (financials.revenueGrowth as number | null) ?? null,
    };

    return {
      fin,
      sector: (yahoo.sector as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Compute sector medians from a list of parsed fundamentals rows.
 * Groups by sector and computes the median for P/E, P/S, P/B, D/E, ROE.
 */
function computeSectorMedians(
  rows: Array<{ sector: string | null; fin: QualityInputFinancials }>,
): Map<string, SectorFinancialMedians> {
  const bySector = new Map<
    string,
    { pe: number[]; ps: number[]; pb: number[]; de: number[]; roe: number[] }
  >();

  for (const r of rows) {
    const key = r.sector ?? "Unknown";
    if (!bySector.has(key)) bySector.set(key, { pe: [], ps: [], pb: [], de: [], roe: [] });
    const bucket = bySector.get(key)!;
    if (r.fin.trailingPE !== null && r.fin.trailingPE > 0) bucket.pe.push(r.fin.trailingPE);
    if (r.fin.priceToSalesTrailing12Months !== null && r.fin.priceToSalesTrailing12Months > 0) bucket.ps.push(r.fin.priceToSalesTrailing12Months);
    if (r.fin.priceToBook !== null && r.fin.priceToBook > 0) bucket.pb.push(r.fin.priceToBook);
    if (r.fin.debtToEquity !== null && r.fin.debtToEquity > 0) bucket.de.push(r.fin.debtToEquity);
    if (r.fin.returnOnEquity !== null && r.fin.returnOnEquity > 0) bucket.roe.push(r.fin.returnOnEquity);
  }

  const medians = new Map<string, SectorFinancialMedians>();
  for (const [sector, bucket] of bySector) {
    medians.set(sector, {
      trailingPE: median(bucket.pe) ?? 25,
      priceToSales: median(bucket.ps) ?? 8,
      priceToBook: median(bucket.pb) ?? 5,
      debtToEquity: median(bucket.de) ?? 25,
      returnOnEquity: median(bucket.roe) ?? 0.15,
    });
  }

  return medians;
}

/**
 * Phase 3: load quality scores from fundamentals_cache for backtest filtering.
 * Reads the latest Yahoo payload for each ticker, computes sector medians,
 * queries SMA200 from daily_prices, and computes the Financial Health Score
 * with sector-relative valuation and trendConfirm populated.
 */
export function loadQualityScoresForBacktest(db: SqliteConnection): Map<string, number> {
  const dbRows = db
    .prepare(
      `
      SELECT ticker, payload_json
      FROM fundamentals_cache
      WHERE payload_json IS NOT NULL AND payload_json != ''
    `,
    )
    .all() as { ticker: string; payload_json: string }[];

  // First pass: extract financials for sector median computation
  const extracted: Array<{
    ticker: string;
    sector: string | null;
    fin: QualityInputFinancials;
  }> = [];

  for (const row of dbRows) {
    const eResult = extractFinancialsFromPayload(row.payload_json);
    if (eResult) extracted.push({ ...eResult, ticker: row.ticker.toUpperCase() });
  }

  // Compute sector medians
  const sectorMedians = computeSectorMedians(extracted);

  // Report sector medians
  console.log(`\nSector financial medians (used for sector-relative scoring):`);
  for (const [s, m] of [...sectorMedians.entries()].sort()) {
    console.log(
      `  ${s}: P/E=${m.trailingPE.toFixed(1)}×  P/S=${m.priceToSales.toFixed(1)}×  P/B=${m.priceToBook.toFixed(1)}×  ` +
      `D/E=${m.debtToEquity.toFixed(1)}×  ROE=${(m.returnOnEquity * 100).toFixed(1)}%`,
    );
  }

  // Second pass: compute quality scores with sector-relative valuation
  const scores = new Map<string, number>();

  for (const e of extracted) {
    try {
      const sector = e.sector;
      const ticker = e.ticker;

      // Query SMA200 from daily_prices for trendConfirm
      const priceRows = db
        .prepare(
          `SELECT close FROM daily_prices WHERE ticker = ? ORDER BY date DESC LIMIT 200`,
        )
        .all(ticker) as { close: number }[];

      let priceAboveSma200: boolean | null = null;
      if (priceRows.length >= 200) {
        const closes = priceRows.map((r) => r.close).reverse();
        const lastClose = closes[closes.length - 1]!;
        const sma200Val = sma(200, closes);
        priceAboveSma200 = sma200Val !== null ? lastClose > sma200Val : null;
      }

      const sectorKey = sector ?? "Unknown";
      const medians = sectorMedians.get(sectorKey);

      const result = computeFinancialHealthScore({
        ticker,
        sector,
        financials: e.fin,
        priceAboveSma200,
        sectorMedians: medians,
      });

      scores.set(ticker, result.financialHealthScore);
    } catch {
      continue;
    }
  }

  return scores;
}

function parseCli(): {
  from: string;
  to: string;
  strategy: "momentum" | "quality-garp" | "vix-momentum";
  qualityFloor: number | null;
} {
  let from = "2021-01-01";
  let to = "2023-12-31";
  let strategy: "momentum" | "quality-garp" | "vix-momentum" = "momentum";
  let qualityFloor: number | null = null;
  let fromExplicit = false;
  let toExplicit = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from" && argv[i + 1]) {
      from = argv[++i]!;
      fromExplicit = true;
    } else if (a === "--to" && argv[i + 1]) {
      to = argv[++i]!;
      toExplicit = true;
    } else if (a === "--strategy" && argv[i + 1]) {
      const s = argv[++i]!;
      if (s === "quality-garp") {
        strategy = "quality-garp";
      } else if (s === "vix-momentum") {
        strategy = "vix-momentum";
      } else {
        strategy = "momentum";
      }
    } else if (a === "--quality-floor" && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      qualityFloor = Number.isFinite(parsed) ? parsed : null;
    }
  }
  if (strategy === "quality-garp") {
    if (!fromExplicit) {
      from = "2023-01-01";
    }
    if (!toExplicit) {
      to = "2025-12-31";
    }
  }
  if (strategy === "vix-momentum") {
    if (!fromExplicit) {
      from = "2022-01-01";
    }
    if (!toExplicit) {
      to = "2025-12-31";
    }
  }
  return { from, to, strategy, qualityFloor };
}

function realOrZero(x: number | null): number {
  return x === null || Number.isNaN(x) ? 0 : x;
}

function closedTradeToDbExit(reason: ClosedBacktestTrade["exitReason"]): BacktestTradeExitReasonDb {
  switch (reason) {
    case "gapOrStop":
      return "TRAILING_STOP";
    case "maxHoldDays":
      return "TIME_EXIT";
    case "standardTakeProfit":
      return "MANUAL";
    case "standardTrendBreak":
      return "REBALANCE_DROP";
    default:
      return "MANUAL";
  }
}

function backtestTradesTableExists(db: SqliteConnection): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backtest_trades' LIMIT 1`)
    .get() as { 1?: number } | undefined;
  return row !== undefined;
}

export function persistBacktestArtifacts(
  db: SqliteConnection,
  from: string,
  to: string,
  result: RunBacktestResult,
  strategy: string,
  windowLabel?: string,
  locked = 0,
): { runId: bigint; tradesInserted: number } {
  const expectancyPctPerTrade = mean(
    result.closedTrades.map((t) =>
      t.entryFillPrice !== 0
        ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
        : 0,
    ),
  );
  const runDate = new Date().toISOString().slice(0, 10);
  const { lastInsertRowid } = insertBacktestRun(db, {
    runDate,
    fromDate: from,
    toDate: to,
    cagr: realOrZero(result.metrics.cagrPct),
    maxDrawdown: realOrZero(result.metrics.maxDrawdownPct),
    winRate: realOrZero(result.metrics.winRatePct),
    sharpeRatio: realOrZero(result.metrics.sharpeRatio),
    totalTrades: result.metrics.totalTrades,
    benchmarkCagr: realOrZero(result.benchmarkCagrPct),
    expectancy: realOrZero(expectancyPctPerTrade),
    strategy,
    windowLabel,
    locked,
  });

  let tradesInserted = 0;
  if (backtestTradesTableExists(db)) {
    for (const t of result.closedTrades) {
      const pnlPct =
        t.entryFillPrice !== 0
          ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
          : 0;
      insertBacktestTrade(db, {
        runRowid: lastInsertRowid,
        ticker: t.ticker,
        entryDate: t.entryDate,
        entryPrice: t.entryFillPrice,
        exitDate: t.exitDate,
        exitPrice: t.exitFillPrice,
        pnlPct,
        exitReason: closedTradeToDbExit(t.exitReason),
      });
      tradesInserted += 1;
    }
  }

  return { runId: lastInsertRowid, tradesInserted };
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");

/** Phase 3 quality-floor sweep thresholds — includes lower values to find actual cutting point. */
const QUALITY_FLOOR_THRESHOLDS = [1, 1.5, 2, 2.5, 3, 4] as const;

interface QualitySweepRow {
  label: string;
  cagr: string;
  maxDd: string;
  sharpe: string;
  winRate: string;
  expectancy: string;
  trades: number;
}

function runSingleBacktestWithLogs(
  db: SqliteConnection,
  from: string,
  to: string,
  label: string,
  options: MomentumBacktestOptions | undefined,
): QualitySweepRow {
  const result = runBacktest(db, from, to, options);
  const expectancyPctPerTrade = mean(
    result.closedTrades.map((t) =>
      t.entryFillPrice !== 0
        ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
        : 0,
    ),
  );
  return {
    label,
    cagr: result.metrics.cagrPct !== null ? result.metrics.cagrPct.toFixed(2) + "%" : "n/a",
    maxDd: result.metrics.maxDrawdownPct !== null ? result.metrics.maxDrawdownPct.toFixed(2) + "%" : "n/a",
    sharpe: result.metrics.sharpeRatio !== null ? result.metrics.sharpeRatio.toFixed(3) : "n/a",
    winRate: result.metrics.winRatePct !== null ? result.metrics.winRatePct.toFixed(1) + "%" : "n/a",
    expectancy: expectancyPctPerTrade !== null ? expectancyPctPerTrade.toFixed(3) + "%" : "n/a",
    trades: result.metrics.totalTrades,
  };
}

if (isMain) {
  void (async () => {
  const cli = parseCli();
  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  try {
    initSchema(db);

    if (cli.strategy === "quality-garp") {
      const result = runQualityGarpBacktest(db, cli.from, cli.to);
      const expectancyPctPerTrade = mean(
        result.closedTrades.map((t) =>
          t.entryFillPrice !== 0
            ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
            : 0,
        ),
      );
      printQualityGarpSummary(cli.from, cli.to, result, expectancyPctPerTrade);

      if (result.metrics.totalTrades === 0 && result.equityPoints.length > 0) {
        console.warn(
          "Quality-GARP: 0 round-trip trades — regime gate, filters, or sparse EPS/quality snapshot vs price data.",
        );
      }

      const dbAbsPath = path.resolve(process.cwd(), config.DB_PATH);
      const { runId, tradesInserted } = persistBacktestArtifacts(db, cli.from, cli.to, result, "GARP_RESEARCH");
      console.log(
        `Saved backtest run to SQLite (id=${runId.toString()}, trades=${tradesInserted}, file=${dbAbsPath}).`,
      );
    } else if (cli.strategy === "vix-momentum") {
      const { runVixMomentumSweep } = await import("./strategies/vix-momentum.js");
      await runVixMomentumSweep(db, cli.from, cli.to);
    } else {
      // Phase 3: quality-floor research (opt-in via --quality-floor N)
      if (cli.qualityFloor !== null) {
        // Baseline run
        const baseline = runSingleBacktestWithLogs(db, cli.from, cli.to, "Baseline (no filter)", undefined);
        const rows: QualitySweepRow[] = [baseline];

        console.log(`\nLoading quality scores from fundamentals_cache...`);
        const qualityByTicker = loadQualityScoresForBacktest(db);
        console.log(`Loaded ${qualityByTicker.size} quality scores.`);

        // Run full sweep at thresholds 3, 4, 5, 6
        for (const threshold of QUALITY_FLOOR_THRESHOLDS) {
          if (threshold < cli.qualityFloor) {
            // Only run thresholds >= --quality-floor
            continue;
          }
          const r = runSingleBacktestWithLogs(
            db, cli.from, cli.to,
            `Quality >= ${threshold}`,
            { qualityFloor: threshold, qualityByTicker },
          );
          rows.push(r);
        }

        // Report score distribution
        const scores = [...qualityByTicker.values()];
        if (scores.length > 0) {
          const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
          const below3 = scores.filter((s) => s < 3).length;
          const below4 = scores.filter((s) => s < 4).length;
          const below5 = scores.filter((s) => s < 5).length;
          const below6 = scores.filter((s) => s < 6).length;
          console.log(`\nScore distribution (n=${scores.length}):`);
          console.log(`  Mean: ${avg.toFixed(1)}/10`);
          console.log(`  < 3: ${below3} tickers (${(below3 / scores.length * 100).toFixed(1)}%)`);
          console.log(`  < 4: ${below4} tickers (${(below4 / scores.length * 100).toFixed(1)}%)`);
          console.log(`  < 5: ${below5} tickers (${(below5 / scores.length * 100).toFixed(1)}%)`);
          console.log(`  < 6: ${below6} tickers (${(below6 / scores.length * 100).toFixed(1)}%)`);
        }

        // Print comparison table
        const labelW = Math.max(...rows.map((r) => r.label.length));
        console.log("");
        console.log("=" .repeat(95));
        console.log("Phase 3 — Quality Floor Backtest Comparison");
        console.log(`Window: ${cli.from}  →  ${cli.to}`);
        console.log("=" .repeat(95));

        const hdr = [
          "Filter".padEnd(labelW),
          "CAGR".padStart(9),
          "MaxDD".padStart(8),
          "Sharpe".padStart(8),
          "WinRate".padStart(8),
          "Expct".padStart(9),
          "Trades".padStart(7),
        ].join("  ");
        console.log(hdr);
        console.log("-".repeat(95));

        for (const r of rows) {
          console.log([
            r.label.padEnd(labelW),
            r.cagr.padStart(9),
            r.maxDd.padStart(8),
            r.sharpe.padStart(8),
            r.winRate.padStart(8),
            r.expectancy.padStart(9),
            String(r.trades).padStart(7),
          ].join("  "));
        }
        console.log("-".repeat(95));
        console.log("");

        // Print full baseline summary for exit bucket reference
        const baselineExitAgg = aggregateExitBuckets(
          runBacktest(db, cli.from, cli.to).closedTrades,
        );
        printBacktestSummary({
          fromDate: cli.from,
          toDate: cli.to,
          metrics: {
            cagrPct: parseFloat(baseline.cagr.replace("%", "")),
            maxDrawdownPct: parseFloat(baseline.maxDd.replace("%", "")),
            winRatePct: parseFloat(baseline.winRate.replace("%", "")),
            sharpeRatio: parseFloat(baseline.sharpe),
            totalTrades: baseline.trades,
          },
          benchmarkCagrPct: null,
          expectancyPctPerTrade: parseFloat(baseline.expectancy.replace("%", "")),
          exitBuckets: baselineExitAgg,
          label: "Baseline (no quality filter)",
        });

        return;
      }

      // Existing single baseline run (no quality args — preserve original behavior)
      const result = runBacktest(db, cli.from, cli.to);
      const expectancyPctPerTrade = mean(
        result.closedTrades.map((t) =>
          t.entryFillPrice !== 0
            ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
            : 0,
        ),
      );
      const exitAgg = aggregateExitBuckets(result.closedTrades);
      printBacktestSummary({
        fromDate: cli.from,
        toDate: cli.to,
        metrics: result.metrics,
        benchmarkCagrPct: result.benchmarkCagrPct,
        expectancyPctPerTrade,
        exitBuckets: exitAgg,
      });

      if (result.metrics.totalTrades === 0 && result.equityPoints.length > 0) {
        console.warn(
          "Backtest: 0 round-trip trades — regime gate, ranking, or data window produced no fills.",
        );
      }

      const dbAbsPath = path.resolve(process.cwd(), config.DB_PATH);
      const { runId, tradesInserted } = persistBacktestArtifacts(db, cli.from, cli.to, result, "MOMENTUM");
      console.log(
        `Saved backtest run to SQLite (id=${runId.toString()}, trades=${tradesInserted}, file=${dbAbsPath}).`,
      );
    }
  } finally {
    db.close();
  }
  })();
}
