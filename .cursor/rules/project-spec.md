# US EQUITY SIGNAL SYSTEM — Cue
**Technical Specification & Architecture Document**
*Version 1.1 · May 2026 · Phase-Wise Build Plan*

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

The system screens the **Nasdaq 100** universe daily, generates quantitative BUY/SELL signals from a RSI + momentum strategy, enriches each signal with AI-driven news sentiment and earnings context, and delivers actionable alerts to the owner via Telegram. All trade execution is manual — the owner places orders independently via the IndMoney app.

### 1.1  Goals

- Remove emotional bias from US equity entry/exit decisions
- Automate the daily research routine: screening 100 stocks in < 2 minutes
- Provide AI-generated context (news sentiment, sector, earnings proximity) per signal
- Maintain < $10/month infrastructure cost on a DigitalOcean or Railway droplet
- Produce a local HTML dashboard for portfolio review without building a backend

### 1.2  Out of Scope (v1)

- Automated order placement via any broker API
- Intraday / real-time streaming data
- Options, futures, or leveraged instruments
- Multi-user access or authentication
- Mobile application

---

## 2  System Overview

Cue is a Node.js CLI pipeline that runs once daily, triggered by a cron job after 4:00 PM ET (US market close). It follows a strict left-to-right data flow:

```
Fetch → Compute → Persist → Enrich → Alert
```

Each stage is a discrete TypeScript module callable independently from the CLI. No stage has a runtime dependency on another stage's in-memory state — all inter-stage communication passes through SQLite.

### 2.1  High-Level Data Flow

```
Fetch (Polygon.io OHLCV + Alpha Vantage news/earnings)
  → Strategy Engine
  → SQLite
  → AI Enrichment (Claude API)
  → Telegram Alert + HTML Dashboard
```

### 2.2  Execution Model

| Trigger | Frequency | Time (ET) | Action |
|---|---|---|---|
| Cron / manual CLI | Daily (weekdays) | 4:10 PM | `pnpm run pipeline` — full fetch → signal → enrich → alert |
| Manual CLI | On-demand | Any | `pnpm run backtest` — replays strategy on historical data |
| Manual CLI | On-demand | Any | `pnpm run dashboard` — regenerates local HTML report |

---

## 3  Architecture

### 3.1  Module Map

| Module | Path | Role | CLI Command |
|---|---|---|---|
| Fetcher | `src/fetcher/` | Pulls OHLCV from Polygon.io; news/earnings/overview from Alpha Vantage; caches to disk + SQLite | `pnpm run fetch` |
| Strategy | `src/strategy/` | Pure functions: RSI(14), 5-day momentum, volume ratio → signal | `pnpm run screen` |
| Backtest | `src/backtest/` | Replays strategy on 3–5yr historical data; prints metrics | `pnpm run backtest` |
| AI Enrichment | `src/ai/` | Calls Claude API per BUY signal: sentiment + earnings + sector | `pnpm run enrich` |
| Alerts | `src/alerts/` | Formats & sends Telegram message per BUY signal | `pnpm run alert` |
| Dashboard | `src/dashboard/` | Generates static HTML report from SQLite; opens in browser | `pnpm run dashboard` |
| Pipeline | `src/pipeline.ts` | Orchestrates full flow in sequence | `pnpm run pipeline` |
| Config | `src/config/` | Single config file; all secrets via env vars | — |

### 3.2  Directory Structure

```
project-root/
├── src/
│   ├── fetcher/         index.ts  cache.ts  types.ts
│   ├── strategy/        signals.ts  indicators.ts  types.ts
│   ├── backtest/        runner.ts  metrics.ts  types.ts
│   ├── ai/              enrichment.ts  prompts.ts  types.ts
│   ├── alerts/          telegram.ts  formatter.ts
│   ├── dashboard/       generator.ts  template.html
│   ├── db/              schema.ts  queries.ts
│   ├── config/          index.ts
│   └── pipeline.ts
├── data/
│   ├── cache/           <TICKER>_<endpoint>.json
│   └── universe/        nasdaq100.json
├── db/                  cue.db  (SQLite — gitignored)
├── dist/                dashboard.html  (generated output)
├── tests/
├── .env.example
├── package.json
└── README.md
```

---

## 4  Data Layer

### 4.1  SQLite Schema

Database file: `db/cue.db`. Managed by `better-sqlite3`. Schema created on first run via `src/db/schema.ts`.

#### 4.1.1  Table: `daily_prices`

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | Row ID |
| ticker | TEXT | NOT NULL | Stock symbol e.g. AAPL |
| date | TEXT | NOT NULL | ISO date YYYY-MM-DD |
| open | REAL | NOT NULL | Open price |
| high | REAL | NOT NULL | High price |
| low | REAL | NOT NULL | Low price |
| close | REAL | NOT NULL | Adjusted close price |
| volume | INTEGER | NOT NULL | Daily volume |
| created_at | TEXT | DEFAULT CURRENT_TIMESTAMP | Insert timestamp |

> **UNIQUE INDEX** on `(ticker, date)` — prevents duplicate inserts on re-run.

#### 4.1.2  Table: `signals`

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | Row ID |
| ticker | TEXT | NOT NULL | Stock symbol |
| date | TEXT | NOT NULL | Signal date |
| signal | TEXT | NOT NULL | `BUY` \| `SELL` \| `HOLD` |
| price | REAL | NOT NULL | Close price on signal date |
| rsi14 | REAL | NOT NULL | RSI(14) value |
| momentum_5d | REAL | NOT NULL | 5-day price return % |
| volume_ratio | REAL | NOT NULL | 20d avg vol / 60d avg vol |
| stop_loss | REAL | NOT NULL | `price * 0.95` (5% below entry) |
| alerted | INTEGER | DEFAULT 0 | 1 = Telegram alert sent |

#### 4.1.3  Table: `enrichments`

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | Row ID |
| signal_id | INTEGER | FK → signals.id | Parent signal |
| sentiment | TEXT | NOT NULL | `BULLISH` \| `NEUTRAL` \| `BEARISH` |
| rationale | TEXT | NOT NULL | 2-sentence plain-English rationale |
| earnings_flag | INTEGER | DEFAULT 0 | 1 = earnings within 7 days |
| earnings_date | TEXT | NULLABLE | Next earnings date if known |
| sector | TEXT | NULLABLE | GICS sector name |
| sector_trend | TEXT | NULLABLE | `BULLISH` \| `NEUTRAL` \| `BEARISH` |
| headlines | TEXT | NOT NULL | JSON array of 3 headline strings |
| created_at | TEXT | DEFAULT CURRENT_TIMESTAMP | Insert timestamp |

#### 4.1.4  Table: `backtest_runs`

| Column | Type | Description |
|---|---|---|
| id | INTEGER | Row ID |
| run_date | TEXT | When backtest was executed |
| from_date | TEXT | Historical data start date |
| to_date | TEXT | Historical data end date |
| cagr | REAL | Compound annual growth rate % |
| max_drawdown | REAL | Maximum drawdown % |
| win_rate | REAL | Winning trades / total trades % |
| sharpe_ratio | REAL | Risk-adjusted return vs risk-free rate |
| total_trades | INTEGER | Number of completed trades |
| benchmark_cagr | REAL | SPY CAGR % for same period |

#### 4.1.5  Table: `positions`

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | Row ID |
| signal_id | INTEGER | FK → signals.id | Parent signal |
| entry_date | TEXT | NOT NULL | YYYY-MM-DD of manual entry confirmation |
| entry_price | REAL | NOT NULL | Actual entry price |
| status | TEXT | NOT NULL | `OPEN` \| `CLOSED` |
| exit_date | TEXT | NULLABLE | Date of exit |
| exit_price | REAL | NULLABLE | Actual exit price |

### 4.2  File Cache

Cache location: `data/cache/<TICKER>_<endpoint>.json`.

| Data Type | Source | Cache TTL | Rationale |
|---|---|---|---|
| OHLCV (daily bars) | Polygon.io | 24h | Full Nasdaq 100 refreshed daily; cache is fallback on API failure |
| News Sentiment | Alpha Vantage | 24h | Fresh enough for daily signal enrichment |
| Company Overview | Alpha Vantage | 7 days | Sector/industry is near-static; saves daily API budget |
| Earnings Calendar | Alpha Vantage | 24h | Must check daily for upcoming earnings within 7 days |

> **Alpha Vantage budget note:** 25 req/day is reserved entirely for enrichment (news, overview, earnings). OHLCV is handled exclusively by Polygon.io. With OVERVIEW cached at 7-day TTL, the effective Alpha Vantage cost per enrichment run is ~1 call per BUY signal (NEWS_SENTIMENT only). EARNINGS_CALENDAR is fetched once per day for the full universe, not per signal.

---

## 5  External APIs & Services

| Service | Purpose | Tier / Cost | Rate Limit | Env Var |
|---|---|---|---|---|
| Polygon.io | OHLCV daily bars for full Nasdaq 100 universe | Free — $0/mo | 5 req/min | `POLYGON_API_KEY` |
| Alpha Vantage | News sentiment, earnings calendar, company overview (enrichment only) | Free — $0/mo | 25 req/day | `ALPHA_VANTAGE_API_KEY` |
| Claude API | AI enrichment per BUY signal | ~$3–5/mo | 1000 req/day | `ANTHROPIC_API_KEY` |
| Telegram Bot API | Alert delivery to personal chat | Free — $0/mo | 30 msg/sec | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| financialmodelingprep.com | Nasdaq 100 constituent list (one-time static JSON seed) | Free endpoint | One-time only | — (seed only) |

### 5.1  Polygon.io Endpoints Used

| Endpoint | Function | Parameters | Used In |
|---|---|---|---|
| `/v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}` | OHLCV daily bars | `adjusted=true&sort=asc&limit=5000` | fetcher, backtest |

### 5.2  Alpha Vantage Endpoints Used

| Endpoint | Function | Parameters | Cache TTL | Used In |
|---|---|---|---|---|
| `NEWS_SENTIMENT` | Latest news + sentiment per ticker | `tickers=TICKER&limit=3` | 24h | AI enrichment |
| `EARNINGS_CALENDAR` | Next earnings date for universe | `horizon=3month` | 24h | AI enrichment |
| `OVERVIEW` | Sector, industry, market cap | `symbol=TICKER` | 7 days | AI enrichment |

### 5.3  Claude API Contract

- **Model:** `claude-sonnet-4-20250514`
- **Max tokens:** 300
- **Called:** once per BUY signal, after cache checks pass
- **Prompt constructed in:** `src/ai/prompts.ts`

#### Prompt Template

```
System:
You are a concise equity research assistant. Respond ONLY in valid JSON.
No prose outside JSON.

User:
Ticker: {TICKER}
Sector: {SECTOR}
Recent headlines (last 24h):
  1. {HEADLINE_1}
  2. {HEADLINE_2}
  3. {HEADLINE_3}
Earnings in next 7 days: {YES|NO} ({DATE if YES})
Sector 5-day performance vs SPY: {SECTOR_PERF}%

Return JSON with exactly these keys:
  sentiment:     "BULLISH" | "NEUTRAL" | "BEARISH"
  rationale:     string (max 2 sentences, plain English)
  earnings_flag: boolean
  sector_trend:  "BULLISH" | "NEUTRAL" | "BEARISH"
```

#### Response Schema (TypeScript)

```typescript
interface AIEnrichment {
  sentiment:     "BULLISH" | "NEUTRAL" | "BEARISH";
  rationale:     string;
  earnings_flag: boolean;
  sector_trend:  "BULLISH" | "NEUTRAL" | "BEARISH";
}
```

---

## 6  Strategy Engine

### 6.1  Universe

- **Nasdaq 100 constituents** — static JSON at `data/universe/nasdaq100.json`, refreshed manually each quarter.
- **Full 100-ticker OHLCV refresh daily** via Polygon.io (5 req/min → completes in ~20 minutes).
- No batching required — Polygon free tier has no daily call cap.

### 6.2  Signal Rules — Exact Implementation

> **These rules are immutable in v1. Changes require explicit document revision.**

#### BUY Signal — ALL three conditions must be true simultaneously

| Condition | Formula | Threshold | Rationale |
|---|---|---|---|
| Oversold RSI | RSI(14) using Wilder's smoothed method on adjusted close | < 35 | Stock is technically oversold vs recent 14-day range |
| Short-term selloff | `(close_today − close_5d_ago) / close_5d_ago × 100` | < −8% | Meaningful dip, not just normal noise |
| Volume confirmation | `avg(volume, 20d) / avg(volume, 60d)` | > 1.5× | Elevated volume confirms institutional activity |

#### EXIT Signal — EITHER condition triggers exit

| Condition | Formula | Threshold | Type |
|---|---|---|---|
| RSI recovery | RSI(14) on adjusted close | > 60 | Take-profit — stock exits oversold territory |
| Stop-loss hit | `(current_price − entry_price) / entry_price × 100` | < −5% | Hard stop — capital preservation |

#### HOLD Signal

Any ticker that does not meet BUY or EXIT criteria emits HOLD. HOLD signals are stored in SQLite but do not trigger Telegram alerts.

#### Live Stop-Loss Monitoring

In live manual execution, stop-loss is monitored at end-of-day close. If close approaches within 2% of the stop level, a **warning alert** is sent via Telegram. This is informational — the user manually executes.

### 6.3  Position Sizing Rules

| Parameter | Value | Notes |
|---|---|---|
| Per-trade allocation | $300 – $500 USD | Fixed; user decides exact amount within range at execution |
| Max concurrent positions | 5 | Hard cap — alert suppressed if `positions WHERE status='OPEN'` count ≥ 5 |
| Total capital deployed | ~$2,500 USD | Maps to ₹2L at current exchange rates |
| Stop-loss level | Entry price × 0.95 | Stored in `signals` table; shown in Telegram alert |
| Take-profit indicator | RSI(14) > 60 | Informational — not a hard price target |

### 6.4  Indicator Implementation Details

#### RSI(14) — Wilder's Smoothed Method

```
1. Calculate 14 daily price changes: delta_i = close_i - close_{i-1}
2. Separate gains (delta > 0) and losses (delta < 0, use absolute value)
3. First avg_gain = mean(gains[0..13])
   First avg_loss = mean(losses[0..13])
4. For each subsequent bar:
     avg_gain = (avg_gain * 13 + current_gain) / 14
     avg_loss = (avg_loss * 13 + current_loss) / 14
5. RS  = avg_gain / avg_loss
6. RSI = 100 - (100 / (1 + RS))
```

Requires **minimum 28 bars** of history for stable values (14 seed + 14 warm-up).
Skip ticker and log warning if fewer than 28 bars are available.

#### 5-Day Momentum

```
momentum_5d = (close[today] - close[today - 5]) / close[today - 5] * 100
```

#### Volume Ratio

```
volume_ratio = avg(volume, last 20 days) / avg(volume, last 60 days)
```

> **Volume guard:** Skip ticker if 20-day average volume < 50,000 shares OR if 60-day average volume = 0. Prevents division-by-zero and filters illiquid names.

---

## 7  Backtest Module

### 7.1  Scope

Validates the RSI + momentum strategy on 3–5 years of historical daily data. Uses OHLCV already stored in SQLite. The runner is a pure replay — iterates day-by-day, applies signal rules, simulates trades, and computes portfolio metrics.

### 7.2  Simulation Rules

- **Entry:** open price of the day *after* a BUY signal fires (next-day market open)
- **Exit:** open price of the day *after* EXIT signal triggers
- **Gap-down stop-loss:** if next-day open ≤ `entry_price × 0.95`, exit at that open price — not at the exact −5% mark
- **Position size:** $400 USD fixed per trade (midpoint of $300–$500 range)
- **Slippage:** 0.1% per leg (0.2% round-trip)
- **No other transaction costs** in v1
- **Max 5 concurrent open positions** enforced in simulation — new BUY is skipped if 5 are already open

> **Future enhancement (Phase 2+):** Add max gap filter — if next-day open > 2% above prior close, skip entry. Prevents chasing gap-up opens that invalidate the oversold premise.

### 7.3  Output Metrics

| Metric | Definition | Gate Target |
|---|---|---|
| CAGR | Compound annual growth rate of simulated portfolio | > SPY CAGR same period |
| Max Drawdown | Largest peak-to-trough portfolio value decline | < 25% |
| Win Rate | Profitable closed trades / total closed trades × 100 | > 50% |
| Sharpe Ratio | (Portfolio return − risk-free rate) / portfolio std dev | > 1.0 |
| Total Trades | Count of completed round-trip trades | Informational |
| Benchmark CAGR | SPY buy-and-hold CAGR for same date range | Comparison baseline |

---

## 8  AI Enrichment Module

### 8.1  Trigger

Enrichment runs after signals are written to SQLite. Processes only rows where `signal = 'BUY'` AND no `enrichments` record exists for that `signal_id`. **Idempotent** — re-running never double-bills the Claude API.

### 8.2  Enrichment Pipeline per Signal

1. Fetch latest 3 headlines from Alpha Vantage `NEWS_SENTIMENT` — check 24h cache first.
2. Get sector from `OVERVIEW` data — check 7-day cache first; pre-loaded weekly for full universe.
3. Check `EARNINGS_CALENDAR` — check 24h cache first (fetched once per day for full universe, not per signal).
4. Compute sector 5-day performance using sector ETF proxy (Section 8.3).
5. Build prompt via `src/ai/prompts.ts` (see Section 5.3).
6. Call Claude API — `claude-sonnet-4-20250514`, max_tokens: 300.
7. Parse JSON response, validate with `zod.safeParse()`.
8. Write record to `enrichments` table in SQLite.

### 8.3  Sector ETF Proxy Map

| GICS Sector | ETF Proxy | Ticker |
|---|---|---|
| Information Technology | Technology Select Sector SPDR | XLK |
| Health Care | Health Care Select Sector SPDR | XLV |
| Financials | Financial Select Sector SPDR | XLF |
| Consumer Discretionary | Consumer Discretionary Select SPDR | XLY |
| Consumer Staples | Consumer Staples Select SPDR | XLP |
| Industrials | Industrial Select Sector SPDR | XLI |
| Energy | Energy Select Sector SPDR | XLE |
| Utilities | Utilities Select Sector SPDR | XLU |
| Real Estate | Real Estate Select Sector SPDR | XLRE |
| Materials | Materials Select Sector SPDR | XLB |
| Communication Services | Communication Services SPDR | XLC |

> Sector ETF OHLCV is fetched via Polygon.io alongside the main universe — once per day, cached 24h. Sector 5-day performance is computed from `daily_prices` table, not via a separate API call.

---

## 9  Alerts Module

### 9.1  Telegram Message Format

One message sent per BUY signal with a corresponding enrichment record. After sending, `signals.alerted` is set to 1.

```
🟢 BUY SIGNAL

Ticker:     AAPL
Price:      $182.45
Stop-Loss:  $173.33

Sentiment:  BULLISH ⚡  Earnings in 5 days ⚠️

Search "AAPL" in IndMoney → US Stocks
```

> Earnings warning `⚠️` appended when `earnings_flag = true`. Informational only — user decides whether to trade into earnings.

### 9.2  Alert Guard Rules

- **Position cap check:** before sending any BUY alert, query `positions WHERE status = 'OPEN'`. If count ≥ 5, suppress alert and log warning.
- **No re-alert:** never send alert for a signal where `alerted = 1`.
- **Enrichment failure fallback:** if Claude API call fails, send alert without AI context rather than silently dropping it.

---

## 10  Dashboard Module

### 10.1  Output

Single static HTML file at `dist/dashboard.html`. Generated by `src/dashboard/generator.ts` reading from SQLite. No web server required — user opens directly in any browser.

### 10.2  Dashboard Sections

| Section | Data Source | Content |
|---|---|---|
| Portfolio Summary | `positions` table | Open position count, total invested capital, unrealized P&L (current close vs entry_price) |
| Active BUY Signals | `signals WHERE signal='BUY' AND alerted=1` | Ticker, price, stop-loss, AI sentiment, earnings flag |
| Recent Signal History | `signals` (last 30 days) | All signals with type, price, RSI, momentum |
| Backtest Summary | `backtest_runs` (latest row) | CAGR, max drawdown, win rate, Sharpe vs SPY |
| Sector Heatmap | `enrichments` | Sector trend distribution (BULLISH / NEUTRAL / BEARISH counts) |

### 10.3  Tech Constraints

- Single HTML file — all CSS and JS inlined. Zero external dependencies at render time.
- Chart library: Chart.js loaded from cdnjs (CDN link only, no pnpm package).
- Data embedded as a JSON blob in a `<script>` tag at generation time.
- Regenerated on every `pnpm run pipeline` and on `pnpm run dashboard`.

---

## 11  Configuration & Environment Variables

### 11.1  .env.example

| Variable | Required | Description |
|---|---|---|
| `POLYGON_API_KEY` | ✅ | Free API key from polygon.io — no daily call cap |
| `ALPHA_VANTAGE_API_KEY` | ✅ | Free key from alphavantage.co — 25 req/day; reserved for enrichment only |
| `ANTHROPIC_API_KEY` | ✅ | Claude API key from console.anthropic.com |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | ✅ | Your personal chat ID — get via @userinfobot |
| `DB_PATH` | — | Path to SQLite file. Default: `./db/cue.db` |
| `CACHE_DIR` | — | Path to cache directory. Default: `./data/cache` |
| `UNIVERSE` | — | `nasdaq100`. Default: `nasdaq100` |
| `MAX_POSITIONS` | — | Max concurrent open positions. Default: `5` |
| `POSITION_SIZE_USD` | — | Fixed trade size in USD. Default: `400` |
| `STOP_LOSS_PCT` | — | Stop-loss % below entry. Default: `5` |
| `BUY_RSI_THRESHOLD` | — | RSI below this = oversold. Default: `35` |
| `BUY_MOMENTUM_THRESHOLD` | — | 5-day return below this = selloff. Default: `-8` |
| `BUY_VOLUME_RATIO` | — | Volume ratio above this = confirmation. Default: `1.5` |
| `EXIT_RSI_THRESHOLD` | — | RSI above this = take profit. Default: `60` |
| `LOG_LEVEL` | — | `debug` \| `info` \| `warn` \| `error`. Default: `info` |

---

## 12  Dependencies

### 12.1  Runtime

| Package | Version | Purpose | Justification |
|---|---|---|---|
| `better-sqlite3` | ^9.x | SQLite client | Synchronous, zero-config, well-typed. No async overhead for local DB. |
| `axios` | ^1.x | HTTP client | Interceptors for retry/backoff on Polygon + Alpha Vantage calls. |
| `node-cron` | ^3.x | Cron scheduler | In-process scheduling for daily pipeline at 4:10 PM ET. |
| `dotenv` | ^16.x | Env var loading | Standard `.env` loading. |
| `zod` | ^3.x | Runtime validation | Validates all external API responses. Prevents silent bad data. |
| `winston` | ^3.x | Logging | Structured logs with configurable level and file transport. |

### 12.2  Dev

| Package | Version | Purpose |
|---|---|---|
| `typescript` | ^5.x | Compiler — strict mode |
| `@types/better-sqlite3` | ^9.x | SQLite type definitions |
| `@types/node` | ^22.x | Node.js type definitions |
| `vitest` | ^1.x | Unit test runner — fast, native ESM |
| `tsx` | ^4.x | Run TypeScript directly without pre-compile |
| `eslint` + `@typescript-eslint` | latest | Static analysis, enforce no-any rule |

> No ORM beyond `better-sqlite3`. No Express. No React. Stack minimalism is a hard constraint.

---

## 13  Error Handling & Resilience

| Failure Mode | Behaviour | Implementation |
|---|---|---|
| Polygon.io rate limit (429) | Exponential backoff: 1s → 2s → 4s, max 3 retries | axios interceptor in `src/fetcher/` |
| Polygon.io data gap | Skip ticker, log warning, continue pipeline | Guard in `src/strategy/signals.ts` |
| Alpha Vantage 429 | Exponential backoff: 1s → 2s → 4s, max 3 retries | axios interceptor in `src/fetcher/` |
| Alpha Vantage daily limit (25 req) | Stop enrichment fetches, use cached data, log warning | Cache-first check before every call |
| Claude API failure | Log error, write signal without enrichment, alert without AI context | try/catch in `src/ai/enrichment.ts` |
| Claude API returns invalid JSON | Retry once with same prompt, then skip enrichment | `zod.safeParse()` with fallback |
| Telegram send failure | Retry once after 5s, log failure, do not block pipeline | try/catch in `src/alerts/telegram.ts` |
| SQLite write failure | Throw and halt pipeline run, log error with context | Transaction wrapper in `src/db/queries.ts` |
| Insufficient bars for RSI | Skip ticker (needs min 28 bars), log debug | Guard: `if (prices.length < 28) skip` |
| Volume guard triggered | Skip ticker if 20d avg vol < 50k or 60d avg = 0 | Guard in `src/strategy/indicators.ts` |

---

## 14  Testing Strategy

### 14.1  Unit Tests (vitest)

All strategy functions are pure — no I/O, no DB calls. 100% of `src/strategy/indicators.ts` and `src/strategy/signals.ts` must be unit-tested before Phase 1 is considered complete.

| Test File | Test Cases |
|---|---|
| `tests/strategy/indicators.test.ts` | RSI(14): known values, all-gains, all-losses, flat price. `momentum_5d`: positive, negative, zero. `volumeRatio`: normal, thin market, zero 60d avg. |
| `tests/strategy/signals.test.ts` | BUY: all 3 conditions true. NOT BUY: each condition fails individually. EXIT: RSI trigger. EXIT: stop-loss trigger. HOLD: default case. |
| `tests/backtest/metrics.test.ts` | CAGR calculation. Sharpe ratio. Max drawdown. Win rate. Gap-down stop fill. |
| `tests/ai/prompts.test.ts` | Prompt renders correctly with all fields. Missing field throws. |
| `tests/db/queries.test.ts` | Insert signal. Duplicate insert ignored. Fetch unenriched signals. Mark alerted. Position insert + status update. |

### 14.2  Integration Smoke Tests

```bash
pnpm run fetch --ticker AAPL --dry-run   # prints cached/fetched data, no DB write
pnpm run screen --ticker AAPL            # prints BUY|SELL|HOLD for single ticker
pnpm run backtest --from 2022-01-01 --to 2023-12-31  # prints metrics, writes to DB
```

---

## 15  Phase-Wise Delivery Plan

### Phase 1 — Core Signal Engine

> **Goal:** A working backtest proves the strategy has edge before any live data flows.

| Task | Module | Deliverable | Done When |
|---|---|---|---|
| Project scaffold | root | `package.json`, `tsconfig.json`, `.env.example`, folder structure | `pnpm install` succeeds |
| SQLite schema | `src/db/` | `schema.ts` creates all 5 tables on first run | Tables exist after `pnpm run db:init` |
| Indicator functions | `src/strategy/` | `rsi14()`, `momentum5d()`, `volumeRatio()` as pure functions | All unit tests pass |
| Signal engine | `src/strategy/` | `generateSignal()` returns `BUY`\|`SELL`\|`HOLD` for given price array | All signal unit tests pass |
| Polygon fetcher | `src/fetcher/` | Fetches + caches OHLCV for single ticker; writes to SQLite | `pnpm run fetch --ticker AAPL` works |
| Full universe fetch | `src/fetcher/` | Fetches all 100 Nasdaq 100 tickers daily; respects 5 req/min limit | Completes without 429 errors |
| Backtest runner | `src/backtest/` | Replays strategy, prints CAGR, drawdown, win rate, Sharpe vs SPY | `pnpm run backtest` completes |

#### Phase 1 Exit Gate — ALL FOUR required:

```
CAGR > SPY CAGR (same 3-year period)
AND Sharpe ratio > 1.0
AND Max drawdown < 25%
AND Win rate > 50%
```

If any gate fails, adjust RSI/momentum thresholds and re-run. Do not proceed to Phase 2 until all four pass.

**Additionally:** After passing all four gates, run a **6-month hold-out backtest** on the most recent 6 months (excluded from training window). CAGR must not degrade more than 50% vs the training period. This is mandatory before Phase 2.

### Phase 2 — Live Screening + Alerts

> **Goal:** System runs daily, screens live prices, sends Telegram alert on BUY signals.

| Task | Module | Deliverable | Done When |
|---|---|---|---|
| Live screener | `src/strategy/` | Screens all cached tickers, writes signals to SQLite | `pnpm run screen` prints signals |
| AI enrichment | `src/ai/` | Claude API call per BUY signal; writes to `enrichments` table | Enrichment row exists in DB |
| Telegram alerts | `src/alerts/` | Sends formatted message per BUY signal; marks `alerted=1` | Message received on phone |
| Pipeline orchestrator | `src/pipeline.ts` | fetch → screen → enrich → alert in sequence | `pnpm run pipeline` completes end-to-end |
| Cron setup | root | `node-cron` triggers pipeline at 4:10 PM ET on weekdays | Runs unattended daily |

**Phase 2 Exit Gate:** Alerts received on Telegram for 5+ consecutive trading days without pipeline errors.

### Phase 3 — Dashboard & Polish

> **Goal:** Local HTML dashboard for portfolio review. VPS deployed for unattended operation.

| Task | Module | Deliverable | Done When |
|---|---|---|---|
| Dashboard generator | `src/dashboard/` | Writes `dist/dashboard.html` from SQLite data | File opens correctly in browser |
| All 5 dashboard sections | `src/dashboard/` | Portfolio, signals, history, backtest, sector heatmap render | All sections display real data |
| README | root | Setup guide: API keys, Telegram bot, IndMoney execution steps | New machine can run from scratch |
| VPS deployment | ops | DigitalOcean $4/mo droplet, PM2, `TZ=America/New_York` set | Pipeline runs unattended 24/7 |

### Phase Summary

| Phase | Duration (est.) | Capital Risk | Key Exit Gate |
|---|---|---|---|
| 1 — Core Signal Engine | 2–3 weeks | Zero (backtest only) | All 4 metrics pass + 6-month hold-out |
| 2 — Live Screening + Alerts | 1–2 weeks | Zero (paper mode) | Alerts on Telegram for 5+ days |
| 3 — Dashboard & Polish | 1 week | ₹2L live capital unlocked | Dashboard renders, VPS deployed |

> **Never deploy live capital before Phase 1 exit gate is fully passed. No exceptions.**

---

## 16  Infrastructure & Deployment

| Component | Service | Cost | Notes |
|---|---|---|---|
| VPS | DigitalOcean Basic Droplet (1 vCPU, 1 GB RAM) | $4/mo | Ubuntu 22.04. Node 22 via nvm. |
| Process Manager | PM2 | Free | Keeps pipeline alive; restarts on crash. |
| Cron | node-cron (in-process) | Free | 4:10 PM ET daily on weekdays. |
| SQLite DB | Local file on droplet | Free | `db/cue.db`. |
| Logs | PM2 logs + winston file transport | Free | Retained 7 days. Tail via `pm2 logs`. |
| Dashboard | `dist/dashboard.html` | Free | SCP to local machine or serve via `pm2-serve`. |

> **Timezone config (critical):** Set `TZ=America/New_York` in the droplet environment or in the PM2 ecosystem config file. `node-cron` does not default to system TZ — without this, the 4:10 PM ET trigger will fire at the wrong time on a UTC droplet.

**Total monthly cost:** ~$4 (VPS) + ~$3–5 (Claude API) + $0 (all other services) = **~$7–9/month**.

---

## 17  Risks & Disclaimers

### 17.1  Technical Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Polygon.io free tier degradation or policy change | Low | Free tier currently unlimited daily calls at 5 req/min. Monitor; upgrade to Starter ($29/mo) if needed. |
| Alpha Vantage 25 req/day exhausted | Low | Reserved for enrichment only. OVERVIEW cached 7 days. ~1 call per BUY signal. |
| Claude API returns invalid JSON | Low | `zod.safeParse()` with retry + graceful degradation to alert without AI context. |
| RSI miscalculation from data gaps | Low | Min 28 bars required; ticker skipped if gap detected. |
| Backtest overfitting | Medium | Mandatory 6-month hold-out validation before Phase 2. |
| VPS downtime missing daily run | Low | PM2 auto-restart. Manual re-run via SSH as fallback. |
| Survivorship bias in backtest | Medium | Backtest uses current Nasdaq 100 constituents only. CAGR likely overstated by 2–4% annually. Treat results as directional, not precise. Document known limitation. |
| Stop-loss gap-down fill | Low | Backtest uses next-day open if below stop level. Live mode sends 2% proximity warning — user must act manually. |

### 17.2  Financial Disclaimer

This system is a personal research tool. It does not constitute financial advice. Past backtest performance does not guarantee future returns. All trade decisions and executions are made solely by the owner. The system operator accepts full responsibility for any financial outcomes.

---

## 18  Appendix — CLI Quick Reference

| Command | Description |
|---|---|
| `pnpm run db:init` | Create SQLite schema — run once on initial setup |
| `pnpm run fetch` | Fetch full Nasdaq 100 universe OHLCV via Polygon.io |
| `pnpm run fetch --ticker AAPL` | Fetch single ticker (dev/test) |
| `pnpm run screen` | Run signal engine on all cached tickers, write to DB |
| `pnpm run backtest` | Replay strategy on full historical data, print metrics |
| `pnpm run backtest --from 2022-01-01 --to 2024-12-31` | Backtest on specific date range |
| `pnpm run enrich` | Run AI enrichment on all unenriched BUY signals |
| `pnpm run alert` | Send Telegram alerts for enriched BUY signals |
| `pnpm run dashboard` | Regenerate `dist/dashboard.html` from SQLite |
| `pnpm run pipeline` | Full flow: fetch → screen → enrich → alert → dashboard |
| `pnpm test` | Run all vitest unit tests |
| `pnpm run lint` | ESLint check — must pass before commit |

---

*© 2026 · Private & Confidential · Cue v1.1*
