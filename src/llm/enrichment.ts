import { z } from "zod";

/** Upper bound for rationale length; keep in sync with prompt schema line. */
export const ENRICHMENT_RATIONALE_MAX_CHARS = 12_000;

export const EnrichmentResultSchema = z.object({
  sentiment: z.enum(["BULLISH", "NEUTRAL", "BEARISH"]),
  rationale: z.string().min(20).max(ENRICHMENT_RATIONALE_MAX_CHARS),
  earningsDate: z.string().nullable(),
  sector: z.string(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
});

export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;
