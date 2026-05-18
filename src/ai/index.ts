export interface EnrichmentResult {
  ticker: string;
  sentiment: "BULLISH" | "NEUTRAL" | "BEARISH";
  rationale: string;
  earningsDate: string | null;
}

export async function enrichSignal(ticker: string, date: string): Promise<EnrichmentResult> {
  void ticker;
  void date;
  throw new Error("Not Implemented");
}
