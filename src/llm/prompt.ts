import type { BuySignalForEnrichmentRow } from "../db/queries.js";
import { ENRICHMENT_RATIONALE_MAX_CHARS, type LLMMessage } from "./types.js";
import type { YahooEnrichmentDto } from "./yahooContext.js";

function stripFence(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("```")) {
    return t
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }
  return t;
}

export function tryParseModelJson(raw: string): unknown {
  const cleaned = stripFence(raw);
  return JSON.parse(cleaned) as unknown;
}

/**
 * Pure prompt builder: bounded context only, no external facts beyond DTO + signal row.
 */
export function buildPrompt(
  ticker: string,
  yahoo: YahooEnrichmentDto,
  signal: BuySignalForEnrichmentRow,
): LLMMessage[] {
  const signalDate = signal.date;
  const returnPctDisplay = signal.momentum12_1Return * 100;
  const headlinesBlock =
    yahoo.headlines.length === 0
      ? "(none in last 7 days)"
      : yahoo.headlines
          .map((h, i) => {
            const src = h.source ?? "unknown";
            const when = h.publishedAt ?? "?";
            return `${i + 1}. ${h.title} — ${src} — ${when}`;
          })
          .join("\n");

  const earningsIso = yahoo.nextEarningsDate;
  const upcoming =
    earningsIso === null
      ? "Not scheduled in next 30 days (per provided calendar)"
      : earningsIso;
  const daysUntil =
    earningsIso === null
      ? "N/A"
      : String(
          calendarDaysBetweenIso(signalDate, earningsIso),
        );

  const earningsRiskClause =
    earningsIso !== null && calendarDaysBetweenIso(signalDate, earningsIso) <= 5
      ? "If the upcoming earnings date is within 5 calendar days of the signal date, your rationale MUST explicitly acknowledge earnings event risk."
      : "";

  const system = `You are a financial signal analyst. You must respond ONLY with valid JSON matching the schema below. Do not include markdown, explanation, or any text outside the JSON object.
Base your analysis SOLELY on the provided context. If context is insufficient, set sentiment to NEUTRAL and confidence to LOW.

Schema: { "sentiment": "BULLISH"|"NEUTRAL"|"BEARISH", "rationale": string (20-${ENRICHMENT_RATIONALE_MAX_CHARS} chars), "earningsDate": string|null (ISO date or null), "sector": string, "confidence": "HIGH"|"MEDIUM"|"LOW" }

Confidence (from provided context only):
- HIGH: clear directional headline evidence consistent with the BUY thesis AND earnings are NOT within 5 calendar days of the signal date (${signalDate}).
- MEDIUM: mixed or sparse headlines, or no material news in the window.
- LOW: conflicting headlines OR earnings within 5 calendar days of the signal date (${signalDate}).

${earningsRiskClause}`;

  const user = `Ticker: ${ticker}
Sector (from overview): ${yahoo.sector ?? "unknown"}
Market Cap: ${yahoo.marketCap === null ? "unknown" : String(yahoo.marketCap)}

Recent News Headlines (last 7 days):
${headlinesBlock}

Upcoming Earnings: ${upcoming}
Days Until Earnings (from signal date ${signalDate}): ${daysUntil}

12-1 Momentum Rank: #${signal.momentumRank} of ${signal.universeRankedCount} (score: ${returnPctDisplay.toFixed(2)}%)
Current Price: ${signal.price}
ATR(14): ${signal.atr14}
Initial Stop: ${signal.initialAtrStop}

Assess sentiment and provide a one-paragraph rationale for this BUY signal.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Full calendar days between two ISO date strings (UTC noon anchor). */
export function calendarDaysBetweenIso(a: string, b: string): number {
  const da = new Date(`${a}T12:00:00Z`);
  const db = new Date(`${b}T12:00:00Z`);
  return Math.round(Math.abs(db.getTime() - da.getTime()) / 86_400_000);
}
