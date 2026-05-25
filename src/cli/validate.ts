/**
 * Zod validation schemas for Cue CLI command options.
 * Provides guaranteed-typed, validated option objects for each subcommand.
 */

import { z } from "zod";

/** YYYY-MM-DD date string. */
const ymdRegex = /^\d{4}-\d{2}-\d{2}$/;

function isValidYmd(v: string): boolean {
  if (!ymdRegex.test(v)) {
    return false;
  }
  const [ys, ms, ds] = v.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
}

const ymdField = z.string().refine(isValidYmd, { message: "Must be a valid YYYY-MM-DD date" });

/** `ingest` subcommand options. */
export const IngestOptsSchema = z.object({
  ticker: z.string().optional(),
  date: ymdField.optional(),
  force: z.boolean().default(false),
});
export type IngestOpts = z.infer<typeof IngestOptsSchema>;

/** `screen` subcommand options. */
export const ScreenOptsSchema = z.object({
  ticker: z.string().optional(),
  date: ymdField.optional(),
  forceRebalance: z.boolean().default(false),
});
export type ScreenOpts = z.infer<typeof ScreenOptsSchema>;

/** `brief` subcommand options. */
export const BriefOptsSchema = z.object({
  mode: z.enum(["rebalance", "stop"]).default("stop"),
  skipDashboard: z.boolean().default(false),
  skipAlert: z.boolean().default(false),
  open: z.boolean().default(false),
});
export type BriefOpts = z.infer<typeof BriefOptsSchema>;

/** `backtest` subcommand options. */
export const BacktestOptsSchema = z.object({
  from: ymdField,
  to: ymdField,
  strategy: z.enum(["momentum", "quality-garp"]).default("momentum"),
});
export type BacktestOpts = z.infer<typeof BacktestOptsSchema>;

/** `enrich-fundamentals` subcommand options. */
export const EnrichFundamentalsOptsSchema = z.object({
  ticker: z.string().optional(),
  limit: z.coerce.number().int().positive().default(3),
  force: z.boolean().default(false),
  date: ymdField.optional(),
});
export type EnrichFundamentalsOpts = z.infer<typeof EnrichFundamentalsOptsSchema>;

/** `execute-stops` subcommand options. */
export const ExecuteStopsOptsSchema = z.object({
  dryRun: z.boolean().default(false),
  date: ymdField.optional(),
});
export type ExecuteStopsOpts = z.infer<typeof ExecuteStopsOptsSchema>;

/** `brief:dashboard` subcommand options. */
export const BriefDashboardOptsSchema = z.object({
  open: z.boolean().default(false),
});
export type BriefDashboardOpts = z.infer<typeof BriefDashboardOptsSchema>;
