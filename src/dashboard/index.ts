import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { initSchema } from "../db/schema.js";
import { DB_PATH, extractDashboardPayload } from "./queries.js";
import { renderHtml } from "./template.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "..", "dist");
const OUT_FILE = path.join(OUT_DIR, "dashboard.html");

const OPEN_BROWSER = process.argv.includes("--open");

const mig = new Database(DB_PATH);
try {
  initSchema(mig);
} finally {
  mig.close();
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const payload = extractDashboardPayload();
const html = renderHtml(payload);

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
