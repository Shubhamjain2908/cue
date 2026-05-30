# Cue — Guardrails
*v1.3 · May 2026 — paths aligned to this repository*

Guardrails are hard constraints. They are not configurable at runtime and must
not be bypassed without an explicit gate override (documented in
`spec/cue-architecture-v1.md` + **`.cursor/rules/project-spec.md`** + committed to repo).

---

## Strategy guardrails (LOCKED)

| Guardrail | Rule | Enforced in |
|---|---|---|
| **Regime gate — BUY suppression** | If QQQ close < SMA(200): suppress all new BUY signals. SELL and stop evaluation run unconditionally. | `src/analysers/momentum-screener.ts` |
| **Top-N hard cap** | At most **3** momentum BUY entries per rebalance pass (`topN = 3` contract). | `src/analysers/momentum-screener.ts` (portfolio cap also tied to `MAX_POSITIONS` in config) |
| **Watchlist bench — no positions** | Ranks `topN+1` … `topN+WATCHLIST_BENCH_DEPTH` persist as `signals.signal = WATCHLIST` on rebalance only; **no** `positions` insert. Depth `0` disables bench end-to-end. | `momentum-screener.ts`, `WATCHLIST_BENCH_DEPTH` in `src/config/index.ts` |
| **Rebalance vs stop** | Full **BUY** ranking on **`rebalance`** / Friday scheduler path; **stop** path runs maintenance (`execute-stops`) without Friday-style screen. | `src/agents/scheduler.ts`, `src/agents/daily-workflow.ts` (`detectRunMode`) |
| **Split adjustment before evaluation** | `adjust-splits` runs after **ingest**, before **screen** / **execute-stops**. Non-critical — Yahoo failure must not abort stop evaluation. | `corporate-actions.ts`, `daily-workflow.ts`, `scheduler.ts` |
| **Locked backtest reference** | Dashboard / briefing backtest metrics use latest **`MOMENTUM` + `locked = 1`** run, not newest `run_date`. New backtests default **unlocked**. | `briefing/queries.ts`, migration `009` |
| **Live performance scope** | Dashboard live P&amp;L aggregates **exclude** `exit_reason IN ('MANUAL', 'REBALANCE_DROP')`. Rotation drops must not inflate closed-trade counts or show 0% win-rate noise. | `briefing/queries.ts` |
| **Live `REBALANCE_DROP` fidelity** | Screener rotation closes persist **`REBALANCE_DROP`** on `positions` (not aliased to `MANUAL`). | `006`, `mapLiveExitReason`, `momentum-screener.ts` |
| **Momentum formula locked** | `(close[today-21] - close[today-252]) / close[today-252]`. Any change requires backtest re-validation against Phase 1 gate metrics. | `src/enrichers/momentum-technical.ts` (and backtest) |
| **ATR multipliers locked** | Base: 4.0×. Tight: 1.5×. Tight trigger: ≥ 25% unrealized. | `src/analysers/momentum-screener.ts` — constants / config as designed |
| **ATR golden rule** | `current_stop_loss` never decreases. `new_stop = MAX(candidate, current_stop_loss)`. | Stop evaluation in `momentum-screener.ts` |
| **MAX_HOLD_DAYS** | Forced time exit on stop evaluation when hold ≥ configured days. | `src/config/index.ts` + screener |
| **Backtest gate** | Any strategy parameter change must re-run backtest and clear: CAGR > 12%, MaxDD < 20%, Sharpe > 1.0, Expectancy > 0. | Manual / CI process |

---

## Data guardrails

| Guardrail | Rule | Enforced in |
|---|---|---|
| **No hallucinated financials** | LLM prompt is bounded; Yahoo DTO + signal row only. | `src/llm/prompt.ts`, `src/llm/enricher.ts` |
| **Zod output validation** | All LLM enrichment JSON validated before `enrichments` write; retry path in enricher. | `src/llm/enricher.ts`, `src/llm/types.ts` |
| **Fetcher currency guard** | Per ticker: `MAX(date)` in `daily_prices` vs expected last ET session — not “time since last HTTP request”. `--force` bypasses. | `src/ingestors/massive-price-ingestor.ts` |
| **Data lag accepted** | Massive EOD may lag 1–2 sessions. | Operational assumption |
| **Yahoo context TTL** | Cache policy in Yahoo bundle fetch. | `src/llm/yahooContext.ts` |

---

## Alert guardrails

| Guardrail | Rule | Enforced in |
|---|---|---|
| **BUY alerts on rebalance-style runs only** | `brief` / dispatcher use `--mode rebalance\|stop`; `stop` runs must not emit BUY alerts. | `src/briefing/telegram-dispatcher.ts` |
| **BUY message derivation is local-only** | Entry range / stop / 1R come from the `signals` row; share count comes from `getConfig()` (`PORTFOLIO_VALUE_USD` when set, else `POSITION_SIZE_USD`) plus optional `enrichments` join. No new tables or external data sources. | `src/briefing/telegram-dispatcher.ts`, `src/briefing/queries.ts` |
| **Stop-path Daily Pulse always fires** | `cue brief --mode stop` sends the Daily Pulse regardless of sell count; rebalance path behavior is unchanged. | `src/briefing/telegram-dispatcher.ts` |
| **Pulse tolerance for missing bars** | If an OPEN ticker has no `daily_prices` row for the resolved pulse `asOf`, skip that ticker with a warning; do not fail the whole pulse. | `src/briefing/telegram-dispatcher.ts`, `src/briefing/queries.ts` |
| **Stop proximity threshold** | `STOP_PROXIMITY_ATR_THRESHOLD = 0.5` (hardcoded). `⚠️ NEAR STOP` fires when `(last_close - current_stop_loss) < atr14 * 0.5`. Not configurable at runtime. | `src/briefing/telegram-dispatcher.ts` |
| **ATR position sizer fallback** | If `PORTFOLIO_VALUE_USD` unset, share count falls back to `floor(POSITION_SIZE_USD / entry_mid)`. Cap: `shares × entry_mid` must not exceed `PORTFOLIO_VALUE_USD × 0.05`. `shares` minimum = 1. | `src/briefing/telegram-dispatcher.ts` |
| **Alert dedup** | `signals.alerted` updated after send (BUY alerts and watchlist bench). | `src/db/queries.ts`, dispatcher |
| **Watchlist bench on rebalance only** | Second Telegram message “Next in Rank”; no sizing/stops; `stop` mode must not send bench. | `src/briefing/telegram-dispatcher.ts` |
| **Enrich must not skip WATCHLIST** | `cue enrich` runs WATCHLIST pass even when no pending BUY rows. | `src/agents/thesis-generator.ts` |

---

## Pipeline guardrails

| Guardrail | Rule | Enforced in |
|---|---|---|
| **Critical step abort** | Non-zero exit on critical step aborts chain. | `src/agents/daily-workflow.ts` (`runPipelineWithSteps`) |
| **Non-critical continuation** | **adjust-splits**, enrich, brief failures logged; chain policy per step `critical` bit. | `daily-workflow.ts` |
| **Post-pipeline healthcheck** | `cue healthcheck` is independent of the 16:05–16:15 chain; Telegram on pass/fail; exit **1** on any failed check or Telegram delivery failure. | `src/agents/healthcheck.ts` |
| **Scheduler idempotency** | At most one **successful** run per ET `YYYY-MM-DD` in window. | `src/agents/scheduler.ts` (`lastRunDate`) |
| **Concurrency lock** | In-process **`isRunning`** plus **`LOCK_PATH`** PID file (`process.kill(pid, 0)` stale clear) so PM2 restarts cannot leave a false “idle” while another instance holds the pipeline. | `src/agents/scheduler.ts` |
| **Mode / flag orthogonality** | `--force-rebalance` vs calendar Friday; `--now` only on `pipeline` for one-shot registry run. | `daily-workflow.ts`, CLI |

---

## Position management guardrails

| Guardrail | Rule | Enforced in |
|---|---|---|
| **Max concurrent positions** | Bounded by screener + `MAX_POSITIONS` policy. | `momentum-screener.ts`, config |
| **Stops persisted** | OPEN rows maintain `current_stop_loss` / `highest_close_since_entry` in DB. | `positions` table + screener / queries |
| **No new BUYs in bear regime** | BUY signals not emitted when QQQ below SMA200 on rebalance path. | `momentum-screener.ts` |

---

## New strategy guardrails

| Guardrail | Rule |
|---|---|
| **Backtest before production code** | No new production screener without multi-year backtest gates (see arch doc). |
| **Signal type isolation** | `signals.signal_type` distinguishes strategies (default **`MOMENTUM`**). |
| **No surprise data sources** | New data vendors require architecture + reliability review. |
| **Quality-GARP standalone screen: CLOSED** | Factor falsified on NDX100 2023–2025. Do not reopen as standalone screener. |
| **Quality as momentum exclusion filter: research-only** | Proposed exclusion rule (`ROE < 15%` or `D/E > 2.0`) is not approved production logic. Requires a separate backtest spec and gate clearance before any code lands in live screening. |
