# Cue v2 — Proposal & Session Handoff
*Prepared: May 2026 · Status: Phase 3 Complete, Phase 4 Spec Ready*

---

## 1. What Cue Is

Cue is a personal US equity swing trading research system. It screens the Nasdaq 100 using cross-sectional momentum, enriches signals with AI thesis generation, and delivers Telegram alerts + a static HTML dashboard. Human executes manually via IndMoney. No automated order placement.

**Stack:** Node.js 22 + TypeScript strict ESM · `better-sqlite3` · `axios` · `zod` · `winston` · `vitest` · `pnpm`  
**Infra:** Oracle Cloud Always Free VM · SQLite · systemd daemon · ~$10/month  
**Data:** Massive.com REST API (EOD prices) · `yahoo-finance2` (AI context: news, earnings, sector)  
**LLM:** Anthropic / OpenAI / Google — runtime switchable via `LLM_PROVIDER` env var  
**Alerts:** Telegram bot

---

## 2. What Has Been Built (Phases 1–3, All Complete)

### Phase 1 — Core Strategy Engine ✅ LOCKED
- **Factor:** Jegadeesh-Titman 12-1 Cross-Sectional Momentum
- **Formula:** `(close[today-21] - close[today-252]) / close[today-252]`
- **Universe:** Nasdaq 100
- **Regime filter:** QQQ > SMA(200) → suppress BUY signals if false; SELL/stop evaluation always runs
- **Rebalance:** Weekly, Friday EOD. Entry: top 3 tickers by momentum rank
- **ATR Trailing Stop:** 4.0× ATR base / 1.5× tight (triggered at ≥25% unrealized profit). Golden rule: stop never moves down
- **Failsafe:** MAX_HOLD_DAYS = 40

**Validated backtest (2023-01-01 → 2025-12-31) — gates locked, do not degrade:**

| Metric | Result | Gate |
|---|---|---|
| CAGR | 21.39% | > 12% |
| Max Drawdown | 11.54% | < 20% |
| Sharpe Ratio | 1.162 | > 1.0 |
| Expectancy | +4.78% | > 0 |

### Phase 2 — AI Enrichment + Alerts ✅ LOCKED
- LLM enrichment per signal: sentiment, rationale, earnings proximity flag, sector, confidence
- Hallucination guard: bounded prompt → `EnrichmentResultSchema` (Zod) + 1-retry
- Telegram alerts: BUY on rebalance, SELL/stop-hit on any mode
- `yahoo-finance2` context: news headlines (24h TTL), earnings calendar (24h TTL), sector profile (7d TTL)

### Phase 3 — Dashboard + Pipeline Orchestrator ✅ COMPLETE (deployed)
- Static HTML dashboard: positions, signals, enrichment context
- Pipeline orchestrator (`src/pipeline.ts`): typed `PipelineStep` registry, `critical` flag, `forwardArgs` injection
- Two run modes: `rebalance` (Friday) and `stop` (Mon–Thu)
- Scheduler: `setInterval` 60s polling, fires at 16:05–16:15 ET window, idempotency guard via `lastRunDate`
- **Bug #5 fixed:** BUY alerts now gated behind `mode === 'rebalance'` — SELL/stop alerts fire on both modes
- **Issue #7 resolved:** Premature GOOGL BUY signal reset
- **Deployed to Oracle Cloud VM** — systemd unit, `EnvironmentFile` for secrets, `Restart=on-failure`

---

## 3. Context: Market Pulse AI (Parallel India System)

Cue was built in parallel with Market Pulse AI — a separate personal equity research system for NSE/Indian markets. Understanding the comparison clarifies what Cue is adding.

**Market Pulse AI stack:** Node.js 22 + TypeScript · `better-sqlite3` · DeepSeek-V3 (via OpenAI-compatible API) · Zerodha Kite Connect · PM2 · Oracle Cloud (same VM)

**What Market Pulse does:**
- Daily 8:45 AM IST pipeline: ingest NSE quotes → enrich technicals → regime classify → screen → AI thesis → portfolio evaluate → HTML briefing via Gmail
- Market regime filter (4 states: BULL_TRENDING / CHOPPY / BEAR_TRENDING / CRISIS) using 8 signals: Nifty vs SMA200, VIX India, FII/DII flows, advance-decline ratio
- Adaptive ATR trailing stop on paper trades (3 signal types: AI_PICK, PORTFOLIO_ADD, momentum_mf)
- Kite portfolio analyser: HOLD/ADD/TRIM/EXIT recommendations per holding
- Multi-factor momentum screener (Nasdaq-style 12-1 momentum, adapted for NSE)

**Current Market Pulse state (May 2026):**
- Regime: BEAR_TRENDING Day 4. Score −7.0. All new entries suppressed.
- Paper trade expectancy still negative: AI_PICK −0.37%, PORTFOLIO_ADD −3.27%, momentum_mf −0.59% (deduplicated, pre-fix cohorts)
- GTT execution gated — activates only when expectancy > 0 over 30+ post-fix closed trades. Not yet met.
- Observe mode only.

**Why building Cue / US system separately:**
- Indian market in extended BEAR_TRENDING phase — no entries permissible under regime rules
- US equity (Nasdaq 100) is independently regime-evaluated — QQQ vs SMA200, CBOE VIX
- Geographic diversification: USD-denominated returns, different macro drivers
- Cue strategy already has validated positive expectancy (+4.78%) — Market Pulse India does not yet

---

## 4. Known Issues (Open Going Into Phase 4)

| # | Severity | Issue | Resolution Path |
|---|---|---|---|
| S1 | **HIGH** | `positions` table missing `highest_close_since_entry` and `current_stop_loss` columns — ATR golden rule unenforceable in DB | Schema migration required |
| S2 | **HIGH** | `signals` UNIQUE constraint is `(ticker, date)` — blocks same-ticker BUY on a rebalance day where prior position exits and re-enters top 3 | Migrate to `UNIQUE(ticker, date, signal)` |
| S3 | MEDIUM | Scheduler has no `isRunning` boolean lock — concurrent tick execution possible if pipeline run exceeds 60s | Add lock to `pipeline.ts` |
| S4 | DATA | Massive.com free tier: 25 calls/day, 5/min. Nasdaq 100 fetcher calls one ticker at a time = 100 calls/day. **4× over free limit** — currently masked by 7-ticker dev subset. Full universe fetch will break. | See §5 solution |
| S5 | LOW | `rankedUniverse=0` logged on stop runs — misleading, ranking intentionally skipped | Cosmetic fix in `screenRunner.ts` |
| S6 | LOW | `backtest_runs` has no `backtest_trades` FK table — individual trade audit not possible | Deferred to Phase 5 |

---

## 5. Phase 4 Plan — Quality-GARP Strategy + Schema Fixes

### 5.1 Schema Migrations (prerequisite, do first)

```sql
-- Fix S1: ATR stop tracking on positions
ALTER TABLE positions ADD COLUMN highest_close_since_entry REAL;
ALTER TABLE positions ADD COLUMN current_stop_loss REAL;

-- Fix S2: allow same ticker BUY/SELL on same date
-- Cannot ALTER UNIQUE constraint — requires table rebuild
CREATE TABLE signals_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  signal TEXT NOT NULL,
  signal_type TEXT NOT NULL DEFAULT 'momentum',  -- 'momentum' | 'quality_garp'
  price REAL NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0,
  momentum_rank INTEGER,
  universe_ranked_count INTEGER,
  momentum_12_1_return REAL,
  atr14 REAL,
  initial_atr_stop REAL,
  UNIQUE (ticker, date, signal, signal_type)
);
INSERT INTO signals_new SELECT *, 'momentum' FROM signals;
DROP TABLE signals;
ALTER TABLE signals_new RENAME TO signals;

-- New: fundamentals cache for Quality-GARP
CREATE TABLE fundamentals_cache (
  ticker TEXT NOT NULL,
  as_of TEXT NOT NULL,
  roe REAL,
  revenue_growth_yoy REAL,
  debt_to_equity REAL,
  pe REAL,
  peg REAL,
  market_cap REAL,
  sector TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, as_of)
);
```

### 5.2 Massive.com Rate Limit Solution

**Problem:** 100 tickers × 1 call each = 100 calls/day. Free tier = 25 calls/day.

**Solution:** Split data sources by strategy:
- **Momentum (Nasdaq 100):** Switch fetcher to Massive.com `/v2/aggs/grouped/daily/{date}` endpoint — returns ALL tickers for a given date in **1 API call**. Eliminates per-ticker calls entirely. Fits free tier.
- **Quality-GARP (S&P 100):** Use `yahoo-finance2` (already in stack) for both fundamentals AND price history. No Massive.com quota consumed.

This resolves the rate limit without a paid upgrade.

### 5.3 Quality-GARP Strategy

**Universe:** S&P 100 (`config/sp100.json` — 100 tickers, liquid, Yahoo covers all)

**Fundamental entry filter (weekly, from `fundamentals_cache`):**
- ROE > 18%
- Revenue growth YoY > 15%
- Debt/Equity < 1.0

**Technical entry filter (from `daily_prices`, computed same as momentum signals):**
- RSI_14 < 45 (pullback, not breakdown)
- Price within 10% below SMA50 (dip entry, structural trend intact)
- Regime gate: QQQ > SMA200 (reuse existing regime check)

**Selection:** Top 3 qualifying tickers ranked by ROE × revenue_growth composite score

**Rebalance:** Friday EOD, same cadence as momentum. Independent top-3 selection — runs in parallel, not instead of momentum.

**Exit rules:**
- ATR trailing stop: 3.0× base / 1.5× tight at ≥20% unrealized (slightly tighter than momentum given fundamental basis)
- MAX_HOLD_DAYS = 60 (longer than momentum's 40 — fundamental thesis needs time)
- Regime exit: QQQ crosses below SMA200 → close all Quality-GARP positions

**Signal type:** `signal_type = 'quality_garp'` in `signals` table — full separation from momentum signals

### 5.4 New Pipeline Step

```
rebalance mode: fetch → enrich-fundamentals → screen → enrich → alert → dashboard
stop mode:      fetch → screen → alert → dashboard
```

New step: `enrich-fundamentals`
- `src/fundamentals/fetcher.ts`
- Fetches Yahoo Finance fundamentals for S&P 100 universe
- Writes to `fundamentals_cache` (weekly refresh, 7-day TTL)
- `critical: false` — fundamentals fetch failure must not block momentum pipeline

### 5.5 Phase 4 Deliverables

| # | Task | Files | Gate |
|---|---|---|---|
| 4.0 | Schema migrations (S1 + S2) | migration file | Blocks everything |
| 4.1 | Fetcher: migrate Nasdaq 100 to grouped daily endpoint | `src/fetcher/index.ts` | Rate limit fix |
| 4.2 | Fundamentals fetcher (Yahoo, S&P 100) | `src/fundamentals/fetcher.ts` | Quality-GARP data |
| 4.3 | Quality-GARP screener | `src/strategy/qualityGarp.ts` | Core strategy |
| 4.4 | `screen` step gains `--strategy` arg | `src/strategy/screenRunner.ts` | Signal separation |
| 4.5 | Pipeline: add `enrich-fundamentals` step | `src/pipeline.ts` | Integration |
| 4.6 | Dashboard: second section for Quality-GARP signals | `src/dashboard/template.ts` | Visibility |
| 4.7 | Backtest Quality-GARP (2022–2025) and gate on Sharpe > 0.8, Expectancy > 0 | `src/backtest/` | Strategy validation |

---

## 6. Phase 5 (Future, Not Specced Yet)

- `backtest_trades` table (individual trade audit, FK to `backtest_runs`)
- IBKR paper account integration (position sync — replaces manual IndMoney tracking)
- FX rate table `(date, pair, rate)` for INR P&L reporting (USD/INR from Yahoo `USDINR=X`)
- Unified dashboard: Momentum section + Quality-GARP section + India Market Pulse section
- `isRunning` concurrency lock on scheduler (deferred from Phase 4 minor fixes)

---

## 7. Current DB Schema (as deployed, end of Phase 3)

```sql
CREATE TABLE daily_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE (ticker, date)
);

CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  signal TEXT NOT NULL,
  price REAL NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0,
  momentum_rank INTEGER,
  universe_ranked_count INTEGER,
  momentum_12_1_return REAL,
  atr14 REAL,
  initial_atr_stop REAL,
  UNIQUE (ticker, date)  -- ⚠ to be migrated in Phase 4
);

CREATE TABLE enrichments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  sentiment TEXT NOT NULL,
  rationale TEXT NOT NULL,
  earnings_flag INTEGER NOT NULL DEFAULT 0,
  earnings_date TEXT,
  sector TEXT,
  sector_trend TEXT,
  headlines TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'LOW',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  entry_price REAL NOT NULL,
  status TEXT NOT NULL,
  exit_date TEXT,
  exit_price REAL
  -- ⚠ missing: highest_close_since_entry, current_stop_loss — Phase 4 migration
);

CREATE TABLE backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  cagr REAL NOT NULL,
  max_drawdown REAL NOT NULL,
  win_rate REAL NOT NULL,
  sharpe_ratio REAL NOT NULL,
  total_trades INTEGER NOT NULL,
  benchmark_cagr REAL NOT NULL,
  expectancy REAL NOT NULL DEFAULT 0
);
```

---

## 8. Environment Variables (current)

| Variable | Description |
|---|---|
| `POLYGON_API_KEY` | Massive.com REST API key (legacy name retained) |
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `google` (default: `anthropic`) |
| `ANTHROPIC_API_KEY` | Required if provider = anthropic |
| `OPENAI_API_KEY` | Required if provider = openai |
| `GOOGLE_API_KEY` | Required if provider = google |
| `TELEGRAM_BOT_TOKEN` | Telegram bot credentials |
| `TELEGRAM_CHAT_ID` | Telegram target chat |

---

*End of Proposal · Phase 4 ready to begin*
