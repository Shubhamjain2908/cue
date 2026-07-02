# Rolling-Window Re-Gate Report
Generated: 2026-07-02
Data range: QQQ 2021-05-17 → 2026-07-01
Universe: 101 tickers
Window: 730d, step: 90d
Gates: CAGR≥12%, MaxDD≤20%, Sharpe≥1, Expectancy≥0%

  #          From            To       CAGR     MaxDD    Sharpe   WinRate      Expct   Trades      Bench    Regime    Gate
-------------------------------------------------------------------------------------------------------------------------
  0    2022-11-18    2024-11-17     25.64%    10.51%     1.325     51.6%      5.64%       64     33.60%      100%    PASS
  1    2023-02-16    2025-02-15     35.21%     8.22%     1.794     54.5%      7.47%       66     34.57%      100%    PASS
  2    2023-05-17    2025-05-16     33.26%     7.88%     1.826     56.5%      8.43%       62     26.63%       90%    PASS
  3    2023-08-15    2025-08-14     34.44%     7.92%     1.938     61.3%      8.13%       62     26.85%       90%    PASS
  4    2023-11-13    2025-11-12     36.47%     8.15%     2.062     67.2%      8.83%       61     29.29%       90%    PASS
  5    2024-02-11    2026-02-10     31.42%     9.05%     1.645     58.8%      6.68%       68     19.29%       90%    PASS
  6    2024-05-11    2026-05-11     35.65%     9.83%     1.765     58.2%      7.83%       67     27.68%       87%    PASS

============================================================
Rolling-Window Re-Gate Summary
============================================================
  Windows:           7
  Gate pass rate:    100.0% (7/7)
  Median CAGR:       34.44%
  Median Sharpe:     1.794
  P10 Sharpe:        1.325

  Worst CAGR window: #0 2022-11-18→2024-11-17 25.64%
  Worst MaxDD window:#0 2022-11-18→2024-11-17 10.51%
  Best CAGR window:  #4 2023-11-13→2025-11-12 36.47%

  Bootstrap 95% CI on per-trade P&L:
    Expectancy: [5.495%, 9.728%]

Note: Current-constituent universe creates survivorship bias. Results are an upper bound.
