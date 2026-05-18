# Cue — Session Handoff Document
*Generated end-of-session · May 2026 · Transitioning to Phase 3*

---

## 1. Current State
* **Phase 1 (Core Engine):** COMPLETE & LOCKED. Cross-sectional momentum (12-1) + close-based ATR trailing stops mathematically validated.
* **Phase 2 (AI & Alerts):** COMPLETE. AI Enrichment pipeline (yfinance + interface-first LLM provider) and Telegram formatting successfully integrated.
* **Phase 3 (Dashboard & Pipeline):** NEXT.

## 2. Phase 2 Architectural Decisions (Landed)
* **Data Source Pivot:** Abandoned Alpha Vantage. All enrichment context (news, earnings, sector, market cap) is sourced locally via `yahoo-finance2` and cached as JSON (`24h` TTL for news/calendar, `7d` TTL for profiles).
* **LLM Abstraction:** Interface-first design (`LLMProvider`) allows runtime swapping between `anthropic`, `openai`, and `google` via `LLM_PROVIDER` env var. Implemented using `axios` to maintain stack consistency with `src/fetcher`.
* **Hallucination Guards:** Bounded prompt mapping strictly to `EnrichmentResultSchema` (Zod). 1-retry loop for malformed JSON. Explicit earnings proximity rules.
* **DB Denormalization:** Upgraded the `signals` table to require momentum fields (`momentum_rank`, `12_1_return`, `atr14`, `stop_loss`) on `BUY` inserts. This guarantees the enrichment module reads state without recomputing quant logic, preventing drift.

## 3. Immediate Next Steps: Phase 3 Execution

### Priority 1: Dashboard (`src/dashboard/`)
We require a zero-dependency static HTML report generator. 
* **Data Source:** Must read directly from `db/cue.db` and embed necessary state (open positions, recent signals, backtest metrics) into the HTML as a JSON blob.
* **UI Constraints:** No web server (`Express`). Just a generated `dist/dashboard.html` file. Use Chart.js via CDN for visual charting (e.g., sector allocation heatmap or portfolio equity curve).
* **Command:** `pnpm run dashboard` should output the file and optionally open it in the default browser.

### Priority 2: Pipeline Orchestrator (`src/pipeline.ts`)
We need a single entry point to run the entire pipeline sequentially for VPS deployment.
* **Flow:** `fetch` → `screen` (strategy) → `enrich` → `alert` → `dashboard`.
* **Resilience:** Must handle intermediate failures gracefully (e.g., if AI enrichment fails, still generate the dashboard).
* **Automation:** Prepare a `cron` configuration or simple polling mechanism within `pipeline.ts` to execute on the `REBALANCE_DAY_OF_WEEK` (Friday post-close) and daily for trailing stops.

## 4. Locked Constraints (Do Not Modify)
* **Stack:** TypeScript strict, Node.js 22+, `better-sqlite3`, `axios`, `zod`, `vitest`.
* **Quant Parameters:** `topN = 3`, `atrMultiplierBase = 4.0`, `atrMultiplierTight = 1.5`. Do not attempt to curve-fit or alter the strategy engine.
* **Simplicity:** No ORMs. No React. Single-file HTML output.


### Baseline Validation (Phase 1 Benchmark)
*Do not accept any future core engine modifications that degrade these metrics.*
* **Test Window:** 2023-01-01 → 2025-12-31 (Post-regime gate operational window)
* **CAGR:** 21.39% (Gate: > 12%)
* **Max Drawdown:** 11.54% (Gate: < 20%)
* **Sharpe Ratio:** 1.162 (Gate: > 1.0)
* **Expectancy:** +4.78% (Gate: > 0)
* **Locked Strategy:** 12-1 Cross-Sectional Momentum, Top 3, 4.0x/1.5x ATR Trailing Stops (Close-based).