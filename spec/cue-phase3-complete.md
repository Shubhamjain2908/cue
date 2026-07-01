# Phase 3 — Quality Floor Research (July 2026)

*Sector-relative Financial Health Score calibration for the Nasdaq 100. Research archive.*

---

## Research Question

Can a **Financial Health Score floor** improve the locked momentum backtest (21.82% CAGR, 1.198 Sharpe) by filtering out weak-quality tickers before ranking?

## Methodology

### Data

- **Universe:** 101 Nasdaq 100 tickers from `fundamentals_cache` (Yahoo payloads, as of 2026-05-20)
- **Prices:** SQLite `daily_prices` (Massive.com), 2023-01-01 → 2025-12-31 window
- **Backtest runner:** `src/backtest/runner.ts` — momentum strategy, locked parameters (QQQ SMA200 regime, 4.0× ATR stops, top-3 rebalance, 5 max positions)

### Formula Evolution

| Version | Change | Mean Score | < 3 |
|---------|--------|:----------:|:---:|
| v1 — Absolute thresholds, no trend | Original formula (absolute P/E < 15, D/E < 0.5) | 1.6 | 93.1% |
| v2 — +SMA200 trend confirm | Added `priceAboveSma200` from `daily_prices` | 2.2 | 72.3% |
| v3 — +Sector-relative valuation | P/E/P/S/P/B scored vs sector median | 2.6 | 57.4% |
| **v4 — +Sector-relative D/E/ROE + weight rebalance** | D/E and ROE scored vs sector median; weights adjusted | **3.6** | **38.6%** |

### v4 Final Formula

**Weights:** profitability 0.30, cashHealth 0.20, valuation 0.25, trendConfirm 0.20, completeness 0.05

**Sub-scores:**

| Sub-score | Method |
|-----------|--------|
| Profitability | ROE: ≥2× sector median = 1, ≥1.5× = 0.85, ≥1× = 0.7, ≥0.5× = 0.4, >0 = 0.2, ≤0 = 0. ROA, gross, operating, profit margins: absolute thresholds (10%, 60%, 20%, 15%) |
| Cash health | D/E: ≤0.5× sector median = 1, ≤1× = 0.7, ≤1.5× = 0.4, >1.5× = 0.1. OCF/FCF positive: binary. Current ratio: ideal 1.5–3. |
| Valuation | P/E, P/S, P/B: ≤0.67× sector median = 1, ≤1× = 0.7, ≤1.5× = 0.4, >1.5× = 0.1 |
| Trend confirm | Close > SMA200 = 1, else 0 |
| Completeness | Fraction of 15 Yahoo financial fields non-null |

## Sweep Results

### Score Distribution (n=101 tickers)

| Metric | Value |
|--------|:-----:|
| Mean | 3.6/10 |
| < 1.5 | 21 tickers (20.8%) |
| < 2.0 | 27 tickers (26.7%) |
| < 2.5 | 35 tickers (34.7%) |
| < 3.0 | 39 tickers (38.6%) |
| < 4.0 | 57 tickers (56.4%) |

### Comparison Table (2023-01-01 → 2025-12-31)

| Filter | CAGR | MaxDD | Sharpe | WinRate | Expct | Trades |
|--------|:----:|:-----:|:------:|:-------:|:-----:|:-----:|
| Baseline | **21.82%** | 10.51% | 1.198 | 54.9% | 4.95% | 102 |
| **Q ≥ 1.0** | **21.82%** | 10.51% | 1.198 | 54.9% | 4.95% | 101 |
| **Q ≥ 1.5** | **22.07%** ✨ | **9.15%** | **1.237** ✨ | 55.7% | 5.27% | 97 |
| Q ≥ 2.0 | 8.64% | 9.15% | 0.456 | 51.4% | 2.38% | 74 |
| Q ≥ 2.5 | 7.31% | 11.07% | 0.358 | 50.8% | 2.41% | 61 |
| Q ≥ 3.0 | 6.63% | 11.07% | 0.303 | 49.2% | 2.25% | 59 |
| Q ≥ 4.0 | 7.61% | 7.53% | 0.477 | 52.8% | 4.27% | 36 |

## Conclusions

### ✅ Soft Gate (Q ≥ 1.5) — Viable

Slightly beats baseline with better Sharpe and lower max drawdown. Excludes only 5 tickers (20.8% of universe below threshold, but most weren't top-3 rank candidates). Deployable as an **advisory exclusion floor** — does not degrade alpha.

### ❌ Hard Gate (≥ 2.0) — Not Recommended

Any threshold ≥ 2.0 cuts CAGR by >60%. Quality and momentum are somewhat uncorrelated in the NDX — filtering on quality alone cuts into alpha. At ≥ 2.0, only 27% of tickers are excluded but CAGR drops from 21.82% → 8.64%.

### Why the Formula Doesn't Gate Harder

1. **Sparse data:** 13/15 Yahoo financial fields are null for most NDX tickers. Only trailing P/E, ROE, and D/E are reliably populated.
2. **Growth nature of NDX:** The index is dominated by high-multiple growth stocks. Even sector-relative thresholds classify most names as "expensive."
3. **Momentum-quality decoupling:** The top tickers by 12-1 momentum aren't consistently the highest-quality names.

## Code Changes

### `src/backtest/types.ts`
- Added `qualityFloor?: number` to `MomentumBacktestOptions`
- Added `qualityByTicker?: ReadonlyMap<string, number>` for pre-computed scores

### `src/analysers/signal-quality.ts`
- Added `SectorFinancialMedians` interface (trailingPE, priceToSales, priceToBook, debtToEquity, returnOnEquity)
- Added `sectorMedians` field to `QualityInput`
- Added `scoreRoeRelative()` and `scoreDeRelative()` helpers
- Modified `computeValuation`, `computeCashHealth`, `computeProfitability` to accept optional `sectorMedians`
- Rebalanced weights to NDX-calibrated values

### `src/backtest/runner.ts`
- Added `loadQualityScoresForBacktest()` — reads `fundamentals_cache`, computes sector medians, queries SMA200, scores each ticker
- Added quality floor check in BUY loop (`qualityFloor !== undefined && score < qualityFloor → continue`)
- Added `--quality-floor N` CLI parameter
- Added sweep logic for thresholds 1.0–6.0 with score distribution report and comparison table

## Future Work

| Idea | Expected Impact |
|------|:---------------:|
| Calibrate profitability for NDX (sector-relative ROA/margins when data exists) | Marginal — data is sparse |
| Backfill `fundamentals_cache` historically (quarterly for 2022–2026) | Enables time-accurate quality scores per rebalance |
| Regime-conditioned floor (e.g., Q ≥ 1.5 in bull, Q ≥ 0 in bear) | Medium — softens floor when momentum is scarce |
| Multi-factor rank (momentum + quality composite) | High — potential to find win-win combinations |
| Sector concentration cap (max 2 per sector) | Medium — diversifies but may cut alpha |

---

*Research conducted 2026-07-02. Backtest window: 2023-01-01 → 2025-12-31. Locked run id=82 (21.82% CAGR baseline).*
