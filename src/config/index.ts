import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import type { SignalThresholds } from "../strategy/types.js";

loadDotenv();

const envSchema = z.object({
  /** Massive.com REST key (https://massive.com/; rebranded from Polygon.io; same key). */
  POLYGON_API_KEY: z.string().min(1),
  ALPHA_VANTAGE_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  DB_PATH: z.string().default("./db/cue.db"),
  CACHE_DIR: z.string().default("./data/cache"),
  UNIVERSE: z.string().default("nasdaq100"),
  MAX_POSITIONS: z.coerce.number().int().positive().default(5),
  POSITION_SIZE_USD: z.coerce.number().positive().default(400),
  STOP_LOSS_PCT: z.coerce.number().positive().default(5),
  MAX_HOLD_DAYS: z.coerce.number().int().positive().default(20),
  SMA_PERIOD: z.coerce.number().int().positive().default(50),
  BUY_RSI_MIN: z.coerce.number().default(45),
  BUY_RSI_MAX: z.coerce.number().default(55),
  EXIT_RSI_THRESHOLD: z.coerce.number().default(0),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
});

export type AppConfig = z.infer<typeof envSchema> & SignalThresholds;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) {
    return cached;
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  const d = parsed.data;
  cached = {
    ...d,
    smaPeriod: d.SMA_PERIOD,
    buyRsiMin: d.BUY_RSI_MIN,
    buyRsiMax: d.BUY_RSI_MAX,
    exitRsiThreshold: d.EXIT_RSI_THRESHOLD,
    stopLossPct: d.STOP_LOSS_PCT,
    maxHoldDays: d.MAX_HOLD_DAYS,
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
