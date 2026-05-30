/**
 * Briefing dashboard CLI: writes `dist/dashboard.html`.
 * Open-position trailing-stop metrics (Task 4.4) are compiled in `./template.ts`.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfig } from "../config/index.js";
import { openCueDb } from "../db/provider.js";
import { extractDashboardPayload } from "./queries.js";
import { renderHtml } from "./template.js";

/** Hardcoded backtest benchmarks for Live Performance comparison (not from `backtest_runs`). */
export const LIVE_PERF_BACKTEST_CAGR_PCT = 21.39;
export const LIVE_PERF_BACKTEST_SHARPE = 1.16;
export const LIVE_PERF_BACKTEST_MAXDD_PCT = 11.54;
export const LIVE_PERF_BACKTEST_EXPECTANCY_PCT = 4.78;
export const LIVE_PERF_BACKTEST_WIN_RATE_PCT = 52.2;

export function runBriefDashboardCli(argv: readonly string[] = process.argv): void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const OUT_DIR = path.resolve(__dirname, "..", "..", "dist");
  const OUT_FILE = path.join(OUT_DIR, "dashboard.html");
  const OPEN_BROWSER = argv.includes("--open");

  const { DB_PATH } = getConfig();
  const mig = openCueDb(DB_PATH);
  try {
    /* schema ensured for fresh DBs before payload extraction */
  } finally {
    mig.close();
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const payload = extractDashboardPayload();
  const html = renderHtml(payload, {
    cagrPct: LIVE_PERF_BACKTEST_CAGR_PCT,
    sharpe: LIVE_PERF_BACKTEST_SHARPE,
    maxDdPct: LIVE_PERF_BACKTEST_MAXDD_PCT,
    expectancyPct: LIVE_PERF_BACKTEST_EXPECTANCY_PCT,
    winRatePct: LIVE_PERF_BACKTEST_WIN_RATE_PCT,
  });

  fs.writeFileSync(OUT_FILE, html, "utf-8");
  console.log(`[dashboard] Written → ${OUT_FILE}`);
  console.log(
    `[dashboard] Open positions: ${payload.open_positions.length} | Regime: ${payload.regime_active ? "BULLISH" : "BEARISH"}`,
  );

  if (OPEN_BROWSER) {
    const cmd =
      process.platform === "darwin"
        ? `open "${OUT_FILE}"`
        : process.platform === "win32"
          ? `start "" "${OUT_FILE}"`
          : `xdg-open "${OUT_FILE}"`;
    try {
      execSync(cmd);
    } catch {
      /* non-fatal on headless hosts */
    }
  }
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");

if (isMain) {
  runBriefDashboardCli();
}
