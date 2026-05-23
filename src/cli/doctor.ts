import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import { resolveDbPath } from "../db/provider.js";
import {
  loadUniverseTickers,
  tryLoadUniverseMeta,
  universeMetaMatchesTickerCount,
} from "../universe/load-universe.js";
import { cueLogger } from "./cue-logger.js";

/** Env keys that must be non-empty for normal operation (values never printed). */
const SENSITIVE_ENV_KEYS = [
  "POLYGON_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "VERTEX_PROJECT_ID",
  "CURSOR_API_KEY",
] as const;

/**
 * Print diagnostics: config parse, DB reachability, selected env presence.
 */
export function runDoctorCli(): void {
  cueLogger.info("doctor_start");
  const config = getConfig();
  const resolved = resolveDbPath(config.DB_PATH);
  const db = new Database(resolved, { readonly: true });
  try {
    db.prepare("SELECT 1 AS ok").get() as { ok: number };
  } finally {
    db.close();
  }

  const envPresent: Record<string, boolean> = {};
  for (const k of SENSITIVE_ENV_KEYS) {
    const v = process.env[k];
    envPresent[k] = v !== undefined && String(v).trim().length > 0;
  }

  const tickers = loadUniverseTickers();
  const meta = tryLoadUniverseMeta();
  const summary = {
    dbPath: resolved,
    dbReadonlyProbe: "ok",
    universe: config.UNIVERSE,
    universeTickerCount: tickers.length,
    universeMetaAsOf: meta?.as_of_date ?? null,
    universeMetaCountMatch:
      meta === null ? null : universeMetaMatchesTickerCount(meta, tickers.length),
    llmProvider: config.LLM_PROVIDER,
    envPresent,
    node: process.version,
  };
  cueLogger.info(`doctor_ok ${JSON.stringify(summary)}`);
  console.log(JSON.stringify(summary, null, 2));
}
