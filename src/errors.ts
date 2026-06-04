export class LLMTimeoutError extends Error {
  constructor(signalId: number, timeoutMs: number) {
    super(`LLM enrichment timed out — signalId=${String(signalId)} after ${String(timeoutMs)}ms`);
    this.name = "LLMTimeoutError";
  }
}

export class RegimeGateNotInitialized extends Error {
  constructor(availableBars: number, requiredBars: number) {
    super(
      `RegimeGateNotInitialized: QQQ has ${String(availableBars)} bars in daily_prices ` +
        `but SMA(${String(requiredBars)}) requires at least ${String(requiredBars)}. ` +
        `Run \`cue ingest\` until ${String(requiredBars)} sessions are available.`,
    );
    this.name = "RegimeGateNotInitialized";
  }
}
