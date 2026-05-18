# US EQUITY SIGNAL SYSTEM — Cue
**Technical Specification & Architecture Document**
*Version 1.3 · May 2026 · Phase-Wise Build Plan*

| | |
|---|---|
| **Status** | Draft — Internal Use Only |
| **Owner** | Engineering |
| **Target Stack** | TypeScript · Node.js 22+ · SQLite |
| **Market** | US Equities — Nasdaq 100 |
| **Execution** | Manual via IndMoney App |
| **Infra Budget** | ~$10 / month |

---

## Table of Contents

1. [Purpose & Scope](#1-purpose--scope)
2. [System Overview](#2-system-overview)
3. [Architecture](#3-architecture)
4. [Data Layer](#4-data-layer)
5. [External APIs & Services](#5-external-apis--services)
6. [Strategy Engine](#6-strategy-engine)
7. [Backtest Module](#7-backtest-module)
8. [AI Enrichment Module](#8-ai-enrichment-module)
9. [Alerts Module](#9-alerts-module)
10. [Dashboard Module](#10-dashboard-module)
11. [Configuration & Environment Variables](#11-configuration--environment-variables)
12. [Dependencies](#12-dependencies)
13. [Error Handling & Resilience](#13-error-handling--resilience)
14. [Testing Strategy](#14-testing-strategy)
15. [Phase-Wise Delivery Plan](#15-phase-wise-delivery-plan)
16. [Infrastructure & Deployment](#16-infrastructure--deployment)
17. [Risks & Disclaimers](#17-risks--disclaimers)
18. [Appendix — CLI Quick Reference](#18-appendix--cli-quick-reference)

---

## 1  Purpose & Scope

This document is the single source of truth for the US Equity Signal System (**Cue**). It defines every component, interface, data flow, API contract, strategy rule, and phased delivery milestone required to implement the system from scratch using Cursor AI.

The system evaluates the **Nasdaq 100** universe via a cross-sectional momentum ranking engine, manages risk via adaptive ATR trailing stops, enriches new entries with AI-driven context (news/earnings), and delivers actionable alerts to the owner via Telegram. Execution is entirely manual via the IndMoney app.

### 1.1  Goals

- Remove emotional bias from US equity entry/exit decisions
- Automate the weekly/daily research routine
- Provide AI-generated context per signal
- Maintain < $10/month infrastructure cost
- Produce a local HTML dashboard for portfolio review without building a backend

### 1.2  Out of Scope (v1)

- Automated order placement via any broker API
- Intraday / real-time streaming data
- Options, futures, or leveraged instruments
- Multi-user access or authentication

---

## 2  System Overview

Cue is a Node.js CLI pipeline. The primary ranking and rebalance run weekly (Friday after 4:00 PM ET). Stop-loss evaluation runs daily (weekdays). It follows a strict left-to-right data flow:

```
Fetch → Compute (Rank/Trailing Stop) → Persist → Enrich → Alert
```

### 2.1  High-Level Data Flow

```
Fetch (Massive.com OHLCV + Alpha Vantage news/earnings)
→ Strategy Engine (12-1 Ranker & ATR Stops)
→ SQLite
→ AI Enrichment (Claude API)
→ Telegram Alert + HTML Dashboard
```

---

## 3  Architecture

### 3.1  Module Map

| Module | Path | Role | CLI Command |
|---|---|---|---|
| Fetcher | `src/fetcher/` | Pulls OHLCV from Massive.com via `axios`; Alpha Vantage for context | `pnpm run fetch` |
| Strategy | `src/strategy/` | Pure functions: 12-1 Ranker, ATR(14), SMA(200) regime filter | `pnpm run screen` |
| Backtest | `src/backtest/` | Replays strategy on historical data; prints metrics | `pnpm run backtest` |
| AI Enrichment | `src/ai/` | Calls Claude API per BUY signal: sentiment + earnings + sector | `pnpm run enrich` |
| Alerts | `src/alerts/` | Formats & sends Telegram message per signal | `pnpm run alert` |
| Dashboard | `src/dashboard/` | Generates static HTML report from SQLite; opens in browser | `pnpm run dashboard` |
| Pipeline | `src/pipeline.ts` | Orchestrates full flow in sequence | `pnpm run pipeline` |

---

## 4  Data Layer

Database file: `db/cue.db`. Managed by `better-sqlite3`. Schema created on first run via `src/db/schema.ts`.

### 4.1  SQLite Schema Key Tables

#### `daily_prices`
`(ticker, date)` UNIQUE. Stores `open, high, low, close, volume` from Massive.com.

#### `signals`
Stores generated `BUY` or `SELL` signals with their associated metrics at the time of generation (Rank score, ATR value, initial stop loss).

#### `enrichments`
Stores the AI rationale, sentiment (`BULLISH | NEUTRAL | BEARISH`), and upcoming earnings dates for generated `BUY` signals.

#### `positions`
Tracks live positions. Stores `entry_date`, `entry_price`, `status (OPEN|CLOSED)`. Tracks `highest_close_since_entry` and `current_stop_loss` for the ATR trailing stop engine.

#### `backtest_runs`
Records historical simulation results (CAGR, Sharpe, Drawdown, Expectancy).

### 4.2  File Cache
Cache location: `data/cache/<TICKER>_<endpoint>.json`.
- OHLCV: 24h TTL
- News Sentiment: 24h TTL
- Company Overview: 7-day TTL
- Earnings Calendar: 24h TTL

---

## 5  External APIs & Services

| Service | Purpose | Rate Limit | Env Var |
|---|---|---|---|
| Massive.com | OHLCV daily bars for full Nasdaq 100 | 5 req/min | `POLYGON_API_KEY` |
| Alpha Vantage | News sentiment, earnings calendar, overview | 25 req/day | `ALPHA_VANTAGE_API_KEY` |
| Claude API | AI enrichment per BUY signal | 1000 req/day | `ANTHROPIC_API_KEY` |
| Telegram Bot | Alert delivery to personal chat | 30 msg/sec | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

---

## 6  Strategy Engine

### 6.1  Universe & Regime Filter

- **Universe:** Nasdaq 100 constituents (`data/universe/nasdaq100.json`).
- **Macro Regime Filter:** `QQQ` must close strictly above its 200-day Simple Moving Average (`SMA200`). If `QQQ <= SMA200`, the regime is considered BEARISH. No new `BUY` signals may be generated. Open positions are managed normally via trailing stops.

### 6.2  Signal Rules — Cross-Sectional Momentum

> **These rules are immutable in v1.3. Changes require explicit document revision.**

#### BUY Signal (Weekly Rebalance)
Evaluated only on `REBALANCE_DAY_OF_WEEK` (default Friday).
1. Filter the universe for tickers with at least `RANKING_LOOKBACK_DAYS` (252) of price history.
2. Calculate the 12-1 month return for each ticker:
   `return = (close[today - 21] - close[today - 252]) / close[today - 252]`
3. Rank the universe descending by this return.
4. Select the Top **3** tickers (`topN` / `MAX_POSITIONS`, locked Phase 1). If the Macro Regime is BULLISH, issue `BUY` signals for tickers in the Top 3 not already held in `positions`.

#### EXIT Signal (Daily Evaluation)
Evaluated daily for all `OPEN` positions.
1. **Trailing Stop Breach:** evaluated on the **daily close** — `today_close <= current_stop_loss` — **not** the intraday low. This avoids liquidity-vacuum wicks and false stop-outs during normal consolidation. When breached, the engine schedules a `SELL` fill at the **next session’s open** (T+1), consistent with the backtest.

### 6.3  Risk Management & Position Sizing

- **Sizing:** $300 - $500 USD fixed per trade. Max **3** concurrent open positions (aligned with `topN` / `MAX_POSITIONS`).
- **Stop breach evaluation (locked Phase 1):** ATR trailing-stop breaches are judged on the **daily official close**, not the session low. Intraday lows are ignored for the breach test so the stop is not triggered by transient, illiquid spikes that do not represent end-of-day risk.
- **Adaptive ATR Trailing Stop:**
  A dynamic stop calculated daily. The stop may only move up; it never moves down (The Golden Rule).

```
initial_stop = entry_price - (ATR_MULTIPLIER_BASE * ATR14_at_entry)
unrealized_pct = ((highest_close - entry_price) / entry_price) * 100

// Tighten stop if profit target reached
multiplier = unrealized_pct >= ATR_TIGHTEN_THRESHOLD_PCT ? ATR_MULTIPLIER_TIGHT : ATR_MULTIPLIER_BASE

candidate_stop = highest_close - (multiplier * ATR14_today)
current_stop = MAX(candidate_stop, previous_stop)
```

### 6.4  Indicator Implementation Details

#### ATR (Average True Range - 14 Period)
Requires High, Low, Close arrays.
`True Range (TR) = MAX((High - Low), ABS(High - Previous Close), ABS(Low - Previous Close))`
ATR is the 14-period Wilder's Smoothed Average of the True Range.

#### 12-1 Momentum Score
`(close[today - RANKING_SKIP_DAYS] - close[today - RANKING_LOOKBACK_DAYS]) / close[today - RANKING_LOOKBACK_DAYS]`

---

## 7  Backtest Module

### 7.1  Scope
Validates the Cross-Sectional Momentum strategy on 3-5 years of historical daily data. Evaluates weekly rebalancing, gap-down logic, and ATR trailing stops.

### 7.2  Simulation Rules
- **Entry:** Open price of the day *after* a BUY signal fires (next-day market open).
- **Exit:** Open price of the day *after* the trailing stop is breached. The breach is detected using the **daily close** vs `current_stop_loss` (not the intraday low).
- **Gap-down fill:** If next-day open <= `current_stop_loss`, the exit fill is the *open price*, not the theoretical stop price.
- **Slippage:** 0.1% per leg (0.2% round-trip).

### 7.3  Phase 1 Exit Gates
| Metric | Definition | Gate Target |
|---|---|---|
| CAGR | Compound annual growth rate of simulated portfolio | **> 12%** |
| Max Drawdown | Largest peak-to-trough portfolio value decline | **< 20%** |
| Sharpe Ratio | (Portfolio return - risk-free rate) / portfolio std dev | **> 1.0** |
| Expectancy | `(WinRate * AvgWin) - (LossRate * AvgLoss)` | **> 0** |

---

## 8  AI Enrichment Module
Called via Claude API per `BUY` signal. Constructs a strict JSON prompt combining Alpha Vantage news headlines, upcoming earnings proximity, and GICS sector categorization. Does not permit LLM hallucinations; bounds responses strictly to the provided context.

---

## 9  Alerts Module
Delivers Telegram messages formatting the Ticker, Entry Price, Adaptive Stop Loss, and AI Rationale. Suppresses alerts if `MAX_POSITIONS` is already reached.

---

## 10  Dashboard Module
A zero-dependency static HTML report generated at `dist/dashboard.html`. Embeds SQLite state as a JSON blob. Renders portfolio health, active signals, backtest metrics, and a sector heatmap using Chart.js.

---

## 11  Configuration & Environment Variables

| Variable | Description |
|---|---|
| `POLYGON_API_KEY` | Massive.com REST API key |
| `ALPHA_VANTAGE_API_KEY` | Alpha Vantage free key |
| `ANTHROPIC_API_KEY` | Claude API key |
| `TELEGRAM_BOT_TOKEN` / `CHAT_ID` | Telegram credentials |
| `MAX_POSITIONS` | Max concurrent open positions; equals momentum `topN` (Default: **`3`** — Phase 1 locked) |
| `RANKING_LOOKBACK_DAYS` | Days for momentum calculation (Default: `252`) |
| `RANKING_SKIP_DAYS` | Recent days to skip for mean-reversion (Default: `21`) |
| `REBALANCE_DAY_OF_WEEK` | 1=Mon, 5=Fri (Default: `5`) |
| `ATR_PERIOD` | Days for ATR calculation (Default: `14`) |
| `ATR_MULTIPLIER_BASE` | Standard stop distance (Default: **`4.0`** — Phase 1 locked) |
| `ATR_MULTIPLIER_TIGHT` | Tightened stop distance (Default: **`1.5`** — Phase 1 locked) |
| `ATR_TIGHTEN_THRESHOLD_PCT` | Profit % to trigger tight stop (Default: **`25.0`** — Phase 1 locked) |
| `MAX_HOLD_DAYS` | Circuit-breaker time exit in trading days (Default: **`40`** — Phase 1 locked) |

---

## 12-14 Standard Setup
(Dependencies: Node 22+, `better-sqlite3`, `zod`, `vitest`. Pure functions require 100% test coverage. Standard error-handling and exponential backoff applied to external APIs).

---

## 15  Phase-Wise Delivery Plan

| Phase | Goal | Exit Gate |
|---|---|---|
| **1 - Core Engine** | Backtest proves edge via 12-1 Ranker & ATR Stops. | **DONE / PASSED** — Final **Test 8** window **2023-01-01 → 2025-12-31** (true operational period post–regime gate): **CAGR 21.39%**, **Sharpe 1.162**, **Max DD 11.54%**, **Expectancy +4.78%** (all gates: CAGR > 12%, Sharpe > 1.0, DD < 20%, Expectancy > 0). |
| 2 - Live Screening | Telegram alerts function on cron. | Alerts received 5+ consecutive days. |
| 3 - Dashboard | Unattended deployment. | Flawless VPS operation. |

> **Phase 1 exit gate is met.** Do not deploy live capital without your own operational checklist (data freshness, slippage assumptions, and manual execution discipline). No exceptions to disciplined process.

---

## Changelog

### v1.3 — May 2026
- **Massive Architectural Pivot:** Abandoned single-asset technical indicators (RSI pullbacks, Volume Spikes) due to mathematically proven negative expectancy ceilings on individual growth stocks.
- Implemented **Cross-Sectional Momentum (12-1 month ranking)**. Strategy now evaluates the universe relatively (Jegadeesh-Titman factor) rather than relying on absolute thresholds.
- Replaced static 5% stop and arbitrary time stops with **Adaptive ATR Trailing Stops** to capture asymmetric upside while actively scaling risk based on asset volatility.
- **Phase 1 locked:** `topN`/`MAX_POSITIONS` = 3, `ATR_MULTIPLIER_BASE` = 4.0, `ATR_MULTIPLIER_TIGHT` = 1.5, `ATR_TIGHTEN_THRESHOLD_PCT` = 25.0, `MAX_HOLD_DAYS` = 40; stop breaches evaluated on **daily close** (not intraday low).
- Overhauled Phase 1 Backtest Gates: Replaced `CAGR > QQQ` with absolute hurdles (`CAGR > 12%, Expectancy > 0, Sharpe > 1.0, Max DD < 20%`) to accurately measure a cash-preserving, risk-adjusted long-only system.

*© 2026 · Private & Confidential · Cue v1.3*
