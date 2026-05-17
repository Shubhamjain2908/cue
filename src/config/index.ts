import { config as loadDotenv } from "dotenv";
import { z } from "zod";

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
  BUY_RSI_THRESHOLD: z.coerce.number().default(60),
  BUY_MOMENTUM_THRESHOLD: z.coerce.number().default(3),
  BUY_VOLUME_RATIO: z.coerce.number().positive().default(1.3),
  EXIT_RSI_THRESHOLD: z.coerce.number().default(45),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
});

export type AppConfig = z.infer<typeof envSchema>;

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
  cached = parsed.data;
  return parsed.data;
}

export function resetConfigCache(): void {
  cached = undefined;
}
