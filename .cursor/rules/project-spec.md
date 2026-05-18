# US EQUITY SIGNAL SYSTEM — Cue
**Technical Specification & Architecture Document**
*Version 1.4 · May 2026 · Phase-Wise Build Plan*

| | |
|---|---|
| **Status** | Active Build |
| **Owner** | Engineering |
| **Target Stack** | TypeScript · Node.js 22+ · SQLite |
| **Market** | US Equities — Nasdaq 100 |
| **Execution** | Manual via IndMoney App |
| **Infra Budget** | ~$10 / month |

---

## 1 Purpose & Scope
This document is the single source of truth for the US Equity Signal System (**Cue**). The system evaluates the Nasdaq 100 universe via a cross-sectional momentum ranking engine, manages risk via adaptive ATR trailing stops, enriches new entries with AI-driven context (news/earnings) using a dynamic LLM provider, and delivers actionable alerts via Telegram. Execution is entirely manual.

---

## 2 Architecture & Data Flow

Cue is a Node.js CLI pipeline. The primary ranking and rebalance run weekly (Friday EOD). Stop-loss evaluation runs daily. 
**Data Flow:** `Fetch (Massive.com OHLCV) → Compute (Ranker) → Persist (SQLite) → Enrich (Yahoo Finance + LLM) → Alert (Telegram) → Dashboard`

| Module | Path | Role | CLI Command |
|---|---|---|---|
| Fetcher | `src/fetcher/` | Pulls OHLCV from Massive.com via `axios` | `pnpm run fetch` |
| Strategy | `src/strategy/` | Pure functions: 12-1 Ranker, ATR(14), QQQ SMA200 filter | `pnpm run screen` |
| Backtest | `src/backtest/` | Historical simulation & exit metrics | `pnpm run backtest` |
| AI Enrichment | `src/ai/` | Builds bounded context via `yahoo-finance2` + LLM provider | `pnpm run enrich` |
| Alerts | `src/alerts/` | Telegram message formatter and dispatcher | `pnpm run alert` |
| Dashboard | `src/dashboard/` | Generates static HTML report from SQLite | `pnpm run dashboard` |
| Pipeline | `src/pipeline.ts` | Orchestrates full flow in sequence | `pnpm run pipeline` |

---

## 3 Data Layer (SQLite)
Database file: `db/cue.db`. Managed by `better-sqlite3`.

* **`daily_prices`:** `(ticker, date)` UNIQUE. Massive.com OHLCV.
* **`signals`:** Stores `BUY`/`SELL` signals. Denormalized momentum context required for BUYs: `momentum_rank`, `universe_ranked_count`, `momentum_12_1_return`, `atr14`, `initial_atr_stop`, `alerted`.
* **`enrichments`:** Stores `sentiment`, `rationale`, `earnings_date`, `sector`, and LLM `confidence`.
* **`positions`:** Tracks live positions. Stores `highest_close_since_entry` and `current_stop_loss`.
* **`backtest_runs`:** Records historical simulation results.

---

## 4 Strategy Engine (Locked Parameters)
**Core Engine:** 12-1 Month Cross-Sectional Momentum (Jegadeesh-Titman factor).
* **Universe / Regime:** Nasdaq 100. Regime is BULLISH only if `QQQ > SMA(200)`.
* **Ranking:** `(close[today - 21] - close[today - 252]) / close[today - 252]`.
* **Rebalance:** Weekly on Friday (`REBALANCE_DAY_OF_WEEK = 5`).
* **Entry:** Top 3 tickers (`topN = 3`).
* **Risk Management:** Close-based ATR Trailing Stop. (Golden rule: stop never moves down).
    * `ATR_PERIOD`: 14
    * `ATR_MULTIPLIER_BASE`: 4.0
    * `ATR_MULTIPLIER_TIGHT`: 1.5 (Triggered when unrealized profit >= 25.0%)
* **Failsafe:** `MAX_HOLD_DAYS` = 40.

---

## 5 AI Enrichment & External APIs
The system abstracts the LLM provider via `src/ai/factory.ts` (Anthropic, OpenAI, or Google). It utilizes a strictly bounded prompt utilizing context solely from `yahoo-finance2` (news headlines, upcoming earnings, sector). The LLM is forced to output structured JSON verified by `Zod`. Alpha Vantage has been deprecated. Network requests are routed via `axios`.

---

## 6 Configuration & Environment

| Variable | Description |
|---|---|
| `POLYGON_API_KEY` | Massive.com REST API key |
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `google` (Default: `anthropic`) |
| `ANTHROPIC_API_KEY` | Required if provider = anthropic |
| `TELEGRAM_BOT_TOKEN` / `CHAT_ID` | Telegram credentials |

---

## 7 Phase-Wise Delivery Plan

| Phase | Goal | Status |
|---|---|---|
| 1 - Core Engine | Backtest proves edge via 12-1 Ranker & ATR Stops. | **DONE** (CAGR 21.3%, Sharpe 1.16) |
| 2 - AI & Alerts | LLM Enrichment + Telegram alerts function. | **DONE** |
| 3 - Dashboard | Static HTML portfolio viewer & unattended VPS deployment. | **PENDING** |