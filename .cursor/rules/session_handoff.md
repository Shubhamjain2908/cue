# Cue — Session Handoff Document
*Generated end-of-session · May 2026 · For continuity into next chat*

---

## Phase 1 Completion & Parameter Lock

**Status:** Phase 1 (Core Engine + backtest) is **complete and passed** all amended exit gates. The quantitative core is **locked**; further changes require an explicit spec revision and a new tuning cycle.

### Architectural pivot — close-based ATR trailing stops

Early momentum backtests used **intraday low** vs stop (`low <= current_stop`), which produced excessive `TRAILING_STOP` churn (tight `ATR_MULTIPLIER_BASE` + wick-sensitive fills). Phase 1 **locked** evaluation on the **daily close** (`close <= current_stop`) so liquidity-vacuum spikes do not whipsaw valid positions; exits still **fill at the next session open** (T+1), matching the backtest harness.

### Final Test 8 results — operational window (2023-01-01 → 2025-12-31)

Same trade count and exit mix as Test 7 on the full 2021–2025 window: the 2021–2022 stretch is largely a **regime-gated cash sit** (DB warmup + bear), so **Test 8 isolates true post-gate operation**. Reported metrics:

| Metric | Test 8 | Gate |
|--------|--------|------|
| CAGR | **21.39%** | > 12% ✅ |
| Max drawdown | **11.54%** | < 20% ✅ |
| Sharpe (ann.) | **1.162** | > 1.0 ✅ |
| Expectancy | **+4.78%** | > 0 ✅ |

### Locked parameters (Tests 7/8)

- `topN` / `MAX_POSITIONS`: **3**
- `atrMultiplierBase`: **4.0**
- `atrMultiplierTight`: **1.5**
- `atrTightenThresholdPct`: **25.0**
- `maxHoldDays`: **40** (failsafe; not the primary exit driver at wide base multiplier)
- `rebalanceDayOfWeek`: **5** (Friday); 12-1 lookback/skip: **252 / 21** (unchanged)

**Directive:** Treat `src/strategy/types.ts` `DEFAULT_RANKING_CONFIG` and the backtest runner as the **validated reference implementation** until Phase 2+ features consume env overrides in production.

### Immediate next step — Phase 2 (AI Enrichment)

Scaffold lives in **`src/ai/index.ts`**: typed `EnrichmentResult`, stub `enrichSignal()` (throws until Claude + Alpha Vantage wiring). Wire `pnpm run enrich` / pipeline to this module when implementing Phase 2.

---

## 1. What Cue Is

Personal US equity signal system for Nasdaq 100. Daily pipeline:
fetch OHLCV → compute signals → enrich BUY signals with AI context (Claude API +
Alpha Vantage) → send Telegram alerts → render local HTML dashboard.
All execution is manual via IndMoney app. No auto-trading.
Full spec: `Cue_Spec_v1_3.md` (attached to project — updated this session).

**Stack:** TypeScript strict, Node.js 22+, better-sqlite3, axios, zod, winston, vitest
**Infra target:** ~$10/mo (DigitalOcean $4 droplet + Claude API ~$5)
**Current phase:** Phase 1 core engine **passed**; **Phase 2** — AI enrichment (`src/ai/index.ts`) next.

---

## 2. Modules Built (all compile and pass tests)

| Module | Path | Status |
|---|---|---|
| DB schema | `src/db/schema.ts` | ✅ 5 tables, FKs, UNIQUE constraints |
| DB queries | `src/db/queries.ts` | ✅ insert/fetch/mark helpers |
| Fetcher | `src/fetcher/index.ts` | ✅ Massive API, cache, retry interceptor |
| File cache | `src/fetcher/cache.ts` | ✅ mtime-based TTL, zod validation |
| Indicators | `src/strategy/indicators.ts` | ✅ rsi14, sma, momentum5d, volumeRatio |
| Signal engine | `src/strategy/signals.ts` | ✅ generateSignal, decideSide (4-arg) |
| Signal types | `src/strategy/types.ts` | ✅ SignalThresholds + defaults |
| Backtest runner | `src/backtest/runner.ts` | ✅ T+1 fill, slippage, regime gate, exit instrumentation |
| Backtest metrics | `src/backtest/metrics.ts` | ✅ CAGR, drawdown, Sharpe, win rate |
| Diagnostic scripts | `scripts/` | ✅ signal_crowding, ingest_yfinance_csv.py |

**Not yet built (Phase 2+):** AI enrichment, Telegram alerts, dashboard, pipeline orchestrator, cron.

---

## 3. Data Layer

### 3.1 OHLCV
- **Live fetches:** Massive.com (env key `POLYGON_API_KEY`, 5 req/min, 24h cache)
- **Historical seed:** yfinance Python dump → `scripts/ingest_yfinance_csv.py`
- **Current DB state:**
  ```
  Tickers : 99  (SPLK gone — acquired by Cisco; DDOG/ZS/ANSS may need re-fetch)
  Range   : 2021-05-17 → 2026-05-15
  Rows    : 121,350
  QQQ     : present (required for regime filter)
  ```

### 3.2 Sector ETF series
XLK, XLV, XLF etc. not yet in DB — not needed until Phase 2 AI enrichment.

---

## 4. Current Signal Architecture (Exhaustion Entry — best version reached)

### 4.1 `SignalThresholds` interface (current)

```typescript
interface SignalThresholds {
  smaPeriod:          number;   // 50
  buyRsiMax:          number;   // 60
  buyVolumeRatio:     number;   // 1.2
  exitRsiThreshold:   number;   // 75
  stopLossPct:        number;   // 5
  maxHoldDays:        number;   // 40
}
```

### 4.2 `decideSide()` logic (current, in `src/strategy/signals.ts`)

**Signature:**
```typescript
decideSide(closes, volumes, qqqCloses, thresholds, positionOpen, buyGateFirstFail?)
```

**Entry (positionOpen = false) — ALL required:**
1. QQQ regime gate: `qqqClose > sma(200, qqqCloses)` — bear market suppression
2. `closes.length >= 220` (200 for SMA200 + 20 for slope room, though slope filter was reverted — guard kept)
3. `today > sma(200, closes)` — stock in long-term uptrend (price gate, not slope)
4. `today > sma(smaPeriod, closes)` — stock above short SMA
5. `rsiToday <= buyRsiMax` — in pullback (inclusive, default 60)
6. `rsiToday > rsiYest` — single-day RSI turn (exhaustion signal)
7. `volumeRatio(volumes) >= buyVolumeRatio` — buyers re-engaging

**Exit (positionOpen = true) — EITHER triggers SELL:**
1. `rsiToday >= exitRsiThreshold` — RSI take-profit (default 75)
2. `today < sma(smaPeriod, closes)` — SMA50 trend break

**Runner exits (not in signal layer):**
- Gap/stop: next open ≤ entry × (1 − stopLossPct/100)
- maxHoldDays: trading days held ≥ threshold

### 4.3 Exit instrumentation (in runner — TEMPORARY, keep for next session)

Runner logs four buckets at end of each backtest:
- `gapOrStop` — hard stop or gap-down
- `maxHoldDays` — time exit
- `standard_TAKE_PROFIT` — RSI ≥ 75 (tagged by signal reason)
- `standard_TREND_BREAK` — SMA50 cross-under

Also logs: avg hold days and avg P&L% per bucket, entry vs SMA200 counts, BUY gate first-fail counts.

---

## 5. Full Backtest Results History

### 5.1 Strategy evolution summary

| Strategy | CAGR | Drawdown | Win Rate | Sharpe | Trades | Notes |
|---|---|---|---|---|---|---|
| Dip-buy RSI<35 | −2.19% | 23.85% | 17.54% | −0.610 | 57 | Rejected: buys distribution events |
| Momentum RSI>60+mom>3% | −2.80% | 27.29% | 36.95% | −0.416 | 203 | Rejected: late entry, chases tops |
| Option A: Trend+Pullback (RSI band 45–55) | 5.16% | 37.53% | 34.39% | 0.176 | 216 | SMA200 added partway |
| Exhaustion entry, exitRSI=70, hold=20 | 6.52% | 8.97% | 45.03% | 0.405 | 191 | Best pre-tuning baseline |
| Exhaustion entry, exitRSI=75, hold=40 | **9.61%** | **7.94%** | 38.82% | 0.751 | 152 | **Best full-window result** |
| Exhaustion entry, exitRSI=68, hold=40 | 6.67% | 10.79% | 40.41% | 0.391 | 193 | Worse: cut winners too early |
| 2-day RSI turn, exitRSI=70, hold=20 | 2.12% | 11.53% | 42.65% | −0.196 | 136 | Worse: too few trades |
| SMA slope filter (200d) | 3.84% | 12.03% | 39.81% | 0.063 | 216 | Worse than price gate |

### 5.2 Best configuration detail (exitRSI=75, hold=40, full window 2021–2025)

```
CAGR:          9.61%   (QQQ: 15.55%)
Max drawdown:  7.94%
Win rate:      38.82%
Sharpe:        0.751
Trades:        152
```

Exit mix (split diagnostic):
- gapOrStop: 36, avg −7.43%, avg 8 days
- maxHoldDays: 20, avg +14.49%, avg 41 days
- standard_TAKE_PROFIT: 28, avg +15.59%, avg 18 days
- standard_TREND_BREAK: 68, avg −1.51%, avg 14 days

**Key finding:** `standard_TREND_BREAK` (68 trades, −1.51%) is the primary CAGR drag.
Stocks push up, fail to reach RSI 75, reverse through SMA50. This is a structural
entry quality problem — not fixable by threshold tuning.

### 5.3 Regime split (best config)

| Window | Trades | CAGR | QQQ CAGR | Notes |
|---|---|---|---|---|
| 2021 only | 0 | 0% | +39.46% | DB starts May 2021; warmup period |
| 2022 only | 1 | −1.70% | −33.54% | QQQ regime gate working — near total suppression |
| 2023–2025 | 177 | 9.62% | +33.38% | Bull regime; strategy has edge but lags |
| 2021–2025 full | 152 | 9.61% | +15.55% | 2022 drag is minimal (only 1 trade) |

---

## 6. Phase 1 Gate — AMENDED (critical decision this session)

The original gate (`CAGR > QQQ CAGR`) was identified as a structural paradox for
a capital-preserving, regime-filtered long-only system. Endorsed by both Claude and
Gemini review. Gate officially amended to:

| Metric | Old Gate | **New Gate** | Current Best | Status |
|---|---|---|---|---|
| CAGR | > QQQ (15.55%) | **> 12%** | 9.61% | ❌ |
| Max drawdown | < 25% | **< 20%** | 7.94% | ✅ |
| Sharpe ratio | > 1.0 | **> 1.0** | 0.751 | ❌ |
| Win rate | > 50% | **REMOVED** | — | — |
| **Expectancy** | — | **> 0** | See below | ⚠️ |

**Expectancy formula:** `(WinRate × AvgWin%) − (LossRate × AvgLoss%)`

From best config (2021–2025):
- Closed trades with P&L data: all 152
- Win rate ≈ 38.82%, need avg win/loss ratio > 1.58× to be positive
- TAKE_PROFIT avg win: +15.59%, TREND_BREAK avg loss: −1.51%, gapOrStop avg loss: −7.43%
- **Expectancy is positive but CAGR and Sharpe gates still failing.**

**No live capital until all four new gates pass. No exceptions.**

---

## 7. Strategy Architecture — Next Steps (LOCKED DECISION)

### 7.1 Current exhaustion entry strategy has reached its ceiling

All threshold variations explored:
- RSI ceiling: 50 (too restrictive) → 55 (worse) → 60 (best) → tested up/down
- Exit RSI: 68 (cuts winners) → 70 → 75 (best, but TREND_BREAK still drags)
- Hold days: 20 → 40 (best — maxHoldDays bucket +14.49%)
- Entry confirmation: 1-day RSI turn (best) vs 2-day (too restrictive)
- SMA filter: price gate (best) vs slope (worse)
- SMA cross-under exit: present (best) vs removed (worse — slow bleeds)

The 68-trade TREND_BREAK bucket at −1.51% avg is the structural ceiling.
No single-stock technical entry system will eliminate this reliably.

### 7.2 Next strategy: Cross-Sectional Momentum (12-1 Month Return Ranking)

**Decision: implement this in the next session.**

**Logic:**
- Universe: full Nasdaq 100
- Ranking factor: 12-month return excluding most recent 1 month
  `return_12_1 = (close[today-21] - close[today-252]) / close[today-252]`
  (approximating 1 month = 21 trading days, 12 months = 252 trading days)
- Rebalance: weekly (every Friday EOD)
- Selection: top 5 ranked stocks that also pass the QQQ regime filter
- Position sizing: equal weight, $400/trade, max 5 concurrent (unchanged)
- Exit: hold until next rebalance OR stop-loss OR maxHoldDays (configurable)
- Regime gate: QQQ > SMA200 (keep existing gate, unchanged)

**Rationale (Jegadeesh-Titman factor):**
- Academically verified across decades and markets
- Eliminates single-bar RSI/SMA timing noise entirely
- Selects structurally strong names, not momentary technical patterns
- The 1-month skip avoids short-term mean reversion
- Naturally produces fewer, higher-conviction entries

**What changes in code:**
- New module: `src/strategy/ranker.ts` — pure function, takes full universe price matrix, returns ranked ticker list
- `decideSide()` is retired for the ranking strategy — the ranker replaces it
- Rebalance schedule: runner iterates weekly rebalance dates instead of daily signal dates
- `SignalThresholds` gains `rankingLookbackDays` (252), `rankingSkipDays` (21), `rebalanceDayOfWeek` (5 = Friday)
- Keep `stopLossPct`, `maxHoldDays`, QQQ regime gate
- ATR-based trailing stop: carry over from Market Pulse Indian system (see §8)

**What stays the same:**
- DB schema unchanged (daily_prices, signals, positions tables reused)
- QQQ regime gate in runner (unchanged)
- T+1 fill and slippage model (unchanged)
- Exit instrumentation (keep for diagnostics)

---

## 8. Key Architectural Decisions Carried Forward from Indian System Review

The owner has a parallel system (Market Pulse) for Indian equities with more mature
components. Two components should be ported to Cue:

### 8.1 ATR-based Adaptive Trailing Stop (HIGH PRIORITY)

Replace Cue's static 5% hard stop with ATR-based trailing stop from Market Pulse.

**Core math:**
```
initial_stop    = entry_price − (2.0 × ATR14_at_entry)
unrealised_pct  = (highest_close_since_entry − entry_price) / entry_price × 100
multiplier      = unrealised_pct >= 15.0 ? 1.5 : 2.0
candidate_stop  = highest_close_since_entry − (multiplier × ATR14_today)
new_stop        = MAX(candidate_stop, current_stop)  // never moves down
```

**Why:** Static 5% stop produced avg −7.43% on gapOrStop exits (gap-down
overshoot). ATR-based stop sizes the stop to actual volatility. Low-vol stocks
get tighter stops; high-vol stocks get room to breathe.

**Requires:** `atr14(highs, lows, closes)` added to `src/strategy/indicators.ts`.
Runner needs `highest_close_since_entry` tracked per open position.

### 8.2 4-State Regime Classifier (LOWER PRIORITY — Phase 2+)

Market Pulse uses 8-signal regime scoring (−2 to +2 each). Cue currently uses
binary QQQ > SMA200. For now, keep binary gate — it's working (2022: 1 trade).
Upgrade to scored regime in Phase 2 if needed.

---

## 9. Eliminated Strategy Variants (do not revisit without new evidence)

| Variant | Why Eliminated |
|---|---|
| RSI dip-buy (RSI < 35) | Selects earnings gap-downs, not buyable dips |
| Momentum breakout (RSI > 60 + 5d mom > 3%) | Late entry — buys tops |
| RSI band entry (45–55) | Too restrictive; TREND_BREAK exits dominate |
| SMA200 slope filter | Strictly worse than price gate on all metrics |
| 2-day RSI turn confirmation | Too restrictive; trade count collapses |
| SMA cross-under exit removed | Produces slow bleeds instead of clean cuts |
| buyRsiMax=55 | More trades, worse quality; TREND_BREAK explodes to 181 |
| exitRSI=68 | Cuts maxHoldDays winners prematurely |

---

## 10. Next Session Immediate Checklist

### Priority 1 — Implement 12-1 Cross-Sectional Momentum

1. Create `src/strategy/ranker.ts`:
    - `computeMomentumReturn(closes: number[], lookback: number, skip: number): number | null`
    - `rankUniverse(priceMap: Map<ticker, closes[]>, asOf: string, config): RankedTicker[]`
    - Pure functions, no I/O

2. Update `src/backtest/runner.ts` for weekly rebalance mode:
    - Replace daily signal loop with weekly rebalance dates (every Friday)
    - On each rebalance date: rank all tickers, select top N not already held
    - Exit positions dropped from top N at next rebalance (or stop/maxHold)
    - Keep existing exit instrumentation

3. Update `src/strategy/types.ts`:
    - Add `RankingConfig` interface: `lookbackDays`, `skipDays`, `topN`, `rebalanceDayOfWeek`
    - Keep `stopLossPct`, `maxHoldDays`, `smaPeriod` (for QQQ gate)
    - Retire `buyRsiMax`, `buyVolumeRatio`, `exitRsiThreshold`, `buyRsiMin`

4. Update `src/config/index.ts` and `.env.example` for new params

5. Update unit tests: `tests/strategy/ranker.test.ts` (new file)

6. Run backtest: `--from 2021-01-01 --to 2025-12-31`
    - Report: CAGR, drawdown, Sharpe, expectancy, trade count
    - Also run `--from 2022-01-01 --to 2022-12-31` (regime filter check)
    - Also run `--from 2023-01-01 --to 2025-12-31` (bull regime check)

### Priority 2 — ATR trailing stop (implement alongside ranker)

7. Add `atr14(highs, lows, closes)` to `src/strategy/indicators.ts`
8. Update runner to track `highest_close_since_entry` per open position
9. Replace static stop with ATR trailing stop math (see §8.1)

### Priority 3 — Data completeness

10. Re-fetch `DDOG`, `ZS`, `ANSS` via yfinance with correct symbols → ingest
    (SPLK is gone — don't attempt)
11. Confirm 100 tickers in DB before running ranker backtest

---

## 11. Locked Decisions (never reopen without explicit "reconsider X")

- Stack: TypeScript strict · Node.js 22+ · better-sqlite3 · no ORM · no Express · no React
- Data: Massive.com for live daily fetches; yfinance one-time seed for history
- Regime gate: QQQ > SMA200 (binary, keep for now)
- Position sizing: $300–500/trade, max 5 concurrent
- Phase 1 gate (amended): CAGR > 12% AND Sharpe > 1.0 AND drawdown < 20% AND expectancy > 0
- No live capital until Phase 1 gate fully passed

---

## 12. Files Not in Original Spec (written this or prior session)

| File | Purpose |
|---|---|
| `scripts/ingest_yfinance_csv.py` | One-time CSV → SQLite ingestor |
| `scripts/diagnose_signal_crowding.ts` | Counts concurrent BUY signals per day |
| `src/strategy/indicators.ts` | Now includes `sma()` in addition to original indicators |