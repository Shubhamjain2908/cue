import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import type { SignalThresholds } from "../enrichers/momentum-types.js";

loadDotenv();

const providerKeySchema = z.enum(["anthropic", "openai", "google", "vertex"]);

const baseEnvSchema = z.object({
  /** Massive.com REST key (https://massive.com/; rebranded from Polygon.io; same key). */
  POLYGON_API_KEY: z.string().min(1),
  ALPHA_VANTAGE_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  DB_PATH: z.string().default("./db/cue.db"),
  CACHE_DIR: z.string().default("./data/cache"),
  UNIVERSE: z.string().default("nasdaq100"),
  MAX_POSITIONS: z.coerce.number().int().positive().default(5),
  POSITION_SIZE_USD: z.coerce.number().positive().default(400),
  STOP_LOSS_PCT: z.coerce.number().positive().default(5),
  MAX_HOLD_DAYS: z.coerce.number().int().positive().default(40),
  SMA_PERIOD: z.coerce.number().int().positive().default(50),
  BUY_RSI_MAX: z.coerce.number().default(60),
  BUY_VOLUME_RATIO: z.coerce.number().positive().default(1.2),
  EXIT_RSI_THRESHOLD: z.coerce.number().default(75),
  LLM_PROVIDER: providerKeySchema.default("anthropic"),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(600),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** GCP project for Vertex AI Gemini (`LLM_PROVIDER=vertex`). */
  VERTEX_PROJECT_ID: z.string().optional(),
  /** Vertex region (default `us-central1`). */
  VERTEX_LOCATION: z.string().default("us-central1"),
  /** Vertex publisher model id (default `gemini-2.0-flash-001`). */
  VERTEX_MODEL: z.string().default("gemini-2.0-flash-001"),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
});

export type LlmProviderKey = z.infer<typeof providerKeySchema>;

export type AppConfig = z.infer<typeof baseEnvSchema> & SignalThresholds;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) {
    return cached;
  }
  const parsed = baseEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  const d = parsed.data;
  const provider = d.LLM_PROVIDER;
  if (provider === "anthropic" && (!d.ANTHROPIC_API_KEY || d.ANTHROPIC_API_KEY.length === 0)) {
    throw new Error("Invalid environment: ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
  }
  if (provider === "openai" && (!d.OPENAI_API_KEY || d.OPENAI_API_KEY.length === 0)) {
    throw new Error("Invalid environment: OPENAI_API_KEY is required when LLM_PROVIDER=openai");
  }
  if (provider === "google" && (!d.GOOGLE_AI_API_KEY || d.GOOGLE_AI_API_KEY.length === 0)) {
    throw new Error("Invalid environment: GOOGLE_AI_API_KEY is required when LLM_PROVIDER=google");
  }
  if (provider === "vertex" && (!d.VERTEX_PROJECT_ID || d.VERTEX_PROJECT_ID.length === 0)) {
    throw new Error("Invalid environment: VERTEX_PROJECT_ID is required when LLM_PROVIDER=vertex");
  }
  cached = {
    ...d,
    smaPeriod: d.SMA_PERIOD,
    buyRsiMax: d.BUY_RSI_MAX,
    buyVolumeRatio: d.BUY_VOLUME_RATIO,
    exitRsiThreshold: d.EXIT_RSI_THRESHOLD,
    stopLossPct: d.STOP_LOSS_PCT,
    maxHoldDays: d.MAX_HOLD_DAYS,
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
