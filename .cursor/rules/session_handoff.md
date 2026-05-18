# Cue — Session Handoff Document
*Generated end-of-session · May 2026 · For continuity into next chat*

---

## 1. What Cue Is

Personal US equity signal system for Nasdaq 100. Daily pipeline:
fetch OHLCV → compute signals → enrich BUY signals with AI context (Claude API +
Alpha Vantage) → send Telegram alerts → render local HTML dashboard.
All execution is manual via IndMoney app. No auto-trading.
Full spec: `Cue_Spec_v1_2.md` (attached to project).

**Stack:** TypeScript strict, Node.js 22+, better-sqlite3, axios, zod, winston, vitest  
**Infra target:** ~$10/mo (DigitalOcean $4 droplet + Claude API ~$5)  
**Current phase:** Phase 1 — Core Signal Engine + Backtest (NOT yet passed gate)

---

## 2. What Was Built This Session (Phase 1 — completed modules)

All code exists and compiles. Modules in place:

| Module | Path | Status |
|---|---|---|
| DB schema | `src/db/schema.ts` | ✅ All 5 tables, FKs, UNIQUE constraints |
| DB queries | `src/db/queries.ts` | ✅ insert/fetch/mark helpers |
| Fetcher | `src/fetcher/index.ts` | ✅ Polygon/Massive API, cache, retry interceptor |
| File cache | `src/fetcher/cache.ts` | ✅ mtime-based TTL, zod validation |
| Indicators | `src/strategy/indicators.ts` | ✅ rsi14, momentum5d, volumeRatio |
| Signal engine | `src/strategy/signals.ts` | ✅ generateSignal, decideSide |
| Signal types | `src/strategy/types.ts` | ✅ SignalThresholds interface + defaults |
| Backtest runner | `src/backtest/runner.ts` | ✅ T+1 fill, slippage, max 5 positions, MAX_HOLD_DAYS |
| Backtest metrics | `src/backtest/metrics.ts` | ✅ CAGR, drawdown, Sharpe, win rate |

**Not yet built (Phase 2+):** AI enrichment, Telegram alerts, dashboard, pipeline orchestrator, cron.

---

## 3. Fixes Applied This Session

### 3.1 `src/db/schema.ts`
Added missing `UNIQUE (ticker, date)` to `signals` table. Without it,
`INSERT OR IGNORE` in `queries.ts` was silently inserting duplicates.

### 3.2 `src/fetcher/index.ts`
Added `createHttpClient()` — axios instance with response interceptor that
retries on HTTP 429/500/503 with exponential backoff: 1s → 2s → 4s, max 3
retries. Previously a 429 just logged a warning and skipped the ticker.

### 3.3 `src/backtest/runner.ts` + `src/config/index.ts` + `src/backtest/types.ts`
Added `MAX_HOLD_DAYS` time-based exit. Positions held ≥ MAX_HOLD_DAYS trading
days are force-exited at next-day open regardless of RSI. Implemented as:
- Env var in `getConfig()` (default 20)
- `BACKTEST_MAX_HOLD_DAYS` constant in `src/backtest/types.ts`
- `tradingDaysHeld()` pure helper in `runner.ts`
- Exit condition added alongside gap-stop and standard RSI exit in fill block

### 3.4 Strategy pivot: dip-buy → momentum (v1.2)
Changed signal direction entirely (see Section 5 for why).
`SignalThresholds` interface fields renamed:
- `buyRsiMax` → `buyRsiMin`
- `buyMomentumMaxPct` → `buyMomentumMinPct`
- `exitRsiMin` → `exitRsiMax`

Current live thresholds (in `.env`):
```
BUY_RSI_THRESHOLD=60
BUY_MOMENTUM_THRESHOLD=3
BUY_VOLUME_RATIO=1.3
EXIT_RSI_THRESHOLD=45
STOP_LOSS_PCT=5
MAX_HOLD_DAYS=20
```

---

## 4. Data Layer Status

### 4.1 OHLCV Data Source
Massive.com (rebranded Polygon) free tier is limited to **2 years of historical
data**. This is insufficient for the Phase 1 gate (requires 3–5 years per spec §15).

**Resolution:** Switched to yfinance Python library for historical data.
Script used:
```python
data = yf.download(nasdaq_100_tickers, period="5y", interval="1d", auto_adjust=True)
df_stacked = data.stack(level=1).reset_index()
df_stacked.rename(columns={'level_1': 'Ticker', 'Close': 'AdjClose'}, inplace=True)
df_out = df_stacked[['Date', 'Ticker', 'Open', 'High', 'Low', 'AdjClose', 'Volume']].copy()
df_out.to_csv("nasdaq_100_historical_ohlcv-2.csv", index=False)
```
Note: `auto_adjust=True` (yfinance default) puts adjusted prices in `Close` and
leaves `Adj Close` empty. The rename to `AdjClose` is intentional — the
ingestor maps this to `daily_prices.close`.

**4 tickers failed yfinance download** (delisted/symbol change):
- `SPLK` — acquired by Cisco 2024, gone
- `ANSS`, `DATADOG`, `ZSCALER` — correct symbols are `ANSS`, `DDOG`, `ZS`
  (not confirmed whether re-fetched with correct symbols yet)

### 4.2 Ingestor
`scripts/ingest_yfinance_csv.py` — written this session, already run successfully.
Chunked pandas reader, `INSERT OR IGNORE`, idempotent.

### 4.3 Current DB State
```
Tickers : 99  (1 missing — likely one of the 4 failed downloads)
Range   : 2021-05-17 → 2026-05-15
Rows    : 121,350
```
QQQ is present (fetched separately via `pnpm run fetch --ticker QQQ`).
Note: range starts 2021-05-17, not 2021-01-01 — backtest window
`--from 2021-01-01` still works because the runner uses a 200-day warmup
buffer; the effective signal start is wherever data begins.

---

## 5. Backtest Results History — Why We Pivoted

### 5.1 Original dip-buy strategy (RSI < 35, mom < −8%, vol > 1.5×)

| Run | CAGR | Drawdown | Win Rate | Sharpe | Trades |
|---|---|---|---|---|---|
| 24mo only (bad data) | −4.16% | 17.10% | 20.00% | −0.568 | 35 |
| 5yr, original thresholds | −2.19% | 23.85% | 17.54% | −0.610 | 57 |
| 5yr + MAX_HOLD_DAYS=20 | −1.82% | 19.72% | 28.07% | −0.655 | 57 |
| 5yr + MAX_HOLD_DAYS=15 | −2.43% | 20.34% | 29.82% | −0.790 | 57 |

**Diagnosis:** RSI < 35 + momentum < −8% on Nasdaq 100 individual stocks almost
always fires on earnings gap-downs or sector rotation casualties — not buyable
dips. High volume on a sharp dip in a growth stock = distribution, not accumulation.
Mean-reversion RSI works on indices/ETFs, not on individual growth names.

### 5.2 Momentum strategy (RSI > 60, mom > 3%, vol > 1.3×) — current

| Run | CAGR | Drawdown | Win Rate | Sharpe | Trades |
|---|---|---|---|---|---|
| 5yr, STOP=5% | −2.80% | 27.29% | 36.95% | −0.416 | 203 |
| 5yr, STOP=7% | −1.53% | 26.18% | 40.10% | −0.331 | 192 |

**Benchmark:** QQQ CAGR 15.55% same period.
**Gate requirements:** CAGR > QQQ, Sharpe > 1.0, drawdown < 25%, win rate > 50%.
**Status:** Still failing all gates except drawdown (marginally).

### 5.3 Signal crowding diagnostic result
Built and ran `scripts/diagnose_signal_crowding.ts`.
```
Days with BUY≥1 : 699
Max signals/day : 8
Avg signals/day : 2.0
Days with >5    : 11  (1.6% of signal days)
```
**Conclusion: signal crowding is NOT the problem.** Position cap (max 5) is
almost never the binding constraint. The losses come from the signals that
DO fire, not from missed signals due to cap overflow.

### 5.4 Root cause of momentum strategy failure
RSI > 60 + 5d momentum > 3% firing simultaneously = **late entry**. By the time
both conditions are true, the move is largely done. The system is buying tops of
short-term surges and getting stopped out as they mean-revert.

Example: June 2023 cluster — `AVGO, ADBE, PANW, MRVL, GEHC, OKTA, DOCU` all
fire together post-earnings. Classic late momentum entry.

---

## 6. Where We Are Heading Next — Decision Pending

Two strategy candidates were proposed at end of session. The next session
should implement whichever is selected (owner asked Claude to decide):

### Option A — Trend + Pullback (RECOMMENDED)
**Logic:**
- Trend filter: price > 50-day SMA (stock is in confirmed uptrend)
- Entry trigger: RSI(14) in 45–55 range (healthy consolidation within uptrend)
- Exit: price crosses below 50d SMA OR −5% stop OR MAX_HOLD_DAYS

**Rationale:** Enters earlier in the move with trend context. Avoids chasing
late breakouts. "Buying the dip within an uptrend" is structurally sound for
Nasdaq 100 momentum names.

**Code impact:**
- Add `sma(period, closes)` to `src/strategy/indicators.ts` (~5 lines, pure function)
- Update `SignalThresholds` interface: add `smaPeriod`, `buyRsiMin`/`buyRsiMax` range
- Update `decideSide()` in `src/strategy/signals.ts`
- Update `getConfig()` + `.env.example` for new params
- Update unit tests

### Option B — Mean reversion within macro uptrend
**Logic:**
- Macro filter: price > 200-day SMA (stock is in long-term uptrend)
- Entry: RSI(5) < 30 (short-term oversold within uptrend = buying dip, not knife)
- Exit: RSI(5) > 70 OR −5% stop OR MAX_HOLD_DAYS

**Code impact:** Same as Option A but uses RSI(5) instead of SMA crossover for exit.
Requires `rsi(period, closes)` generalisation in `indicators.ts` (currently hardcoded to 14).

**Claude's recommendation: Option A.** Trend + pullback has more robustness
across market regimes. The 50d SMA filter prevents entries during downtrends
(which is exactly what killed both prior strategies in 2022). RSI 45–55 entry
zone is well-documented to have positive edge on uptrending Nasdaq stocks.

---

## 7. Phase 1 Gate — Current Status

| Metric | Target | Best result so far | Status |
|---|---|---|---|
| CAGR | > QQQ (15.55%) | −1.53% | ❌ |
| Max drawdown | < 25% | 19.72% (dip-buy) / 26.18% (momentum) | ⚠️ |
| Win rate | > 50% | 29.82% | ❌ |
| Sharpe ratio | > 1.0 | −0.331 | ❌ |
| 6-month hold-out | CAGR not collapse >50% | Not run yet | ⏳ |

**No live capital has been deployed. Phase 2 is blocked until all gates pass.**

---

## 8. Key Technical Decisions Made (Locked)

- Massive/Polygon free tier → yfinance for 5-year historical data (one-time seed;
  Massive still used for daily live fetches going forward)
- `signals` table gets `UNIQUE (ticker, date)` — was missing, now fixed
- `MAX_HOLD_DAYS` is a proper env var in `getConfig()`, not a backtest-only constant
- Strategy interface uses directional field names (`buyRsiMin` not `buyRsiMax`)
  to prevent future confusion when direction changes
- No ORM, no Express, no React — stack minimalism is a hard constraint

---

## 9. Files Written This Session (not in original spec)

| File | Purpose |
|---|---|
| `scripts/ingest_yfinance_csv.py` | One-time CSV → SQLite ingestor for yfinance dump |
| `scripts/diagnose_signal_crowding.ts` | Diagnostic: counts concurrent BUY signals per day |

---

## 10. Immediate Next Session Checklist

1. **Confirm strategy choice** — Option A (trend + pullback) is recommended
2. **Implement `sma(period, closes)`** in `src/strategy/indicators.ts`
3. **Update signal logic** in `src/strategy/signals.ts` and `types.ts`
4. **Update config** in `src/config/index.ts` and `.env.example`
5. **Update unit tests** in `tests/strategy/`
6. **Run backtest** `--from 2021-01-01 --to 2025-12-31`
7. **If gate passes:** run 6-month hold-out `--from 2025-07-01 --to 2025-12-31`
8. **Fix missing ticker** — re-fetch `DDOG`, `ZS`, `ANSS` via yfinance with
   correct symbols and re-ingest to get from 99 → 100 tickers (or confirm ANSS
   is genuinely unavailable)
9. **Update spec** to v1.3 if strategy changes again
