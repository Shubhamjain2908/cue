# Cue — Guardrails
*v1.5 · June 2026 — Phase 9b (next-morning scheduler, T-1 ingest, SELL alerts)*

Guardrails are hard constraints. They are not configurable at runtime and must
not be bypassed without an explicit gate override (documented in **`.cursor/rules/cue-sou.md`** + committed to repo).

---

## Strategy guardrails (LOCKED)

| Guardrail | Rule | Enforced in |
|---|---|---|
| **Regime gate — BUY suppression** | If QQQ close < SMA(200): suppress all new BUY signals. SELL and stop evaluation run unconditionally. | `src/analysers/momentum-screener.ts` |
| **Top-N hard cap** | At most **3** momentum BUY entries per rebalance pass (`topN = 3` contract). | `src/analysers/momentum-screener.ts` (portfolio cap also tied to `MAX_POSITIONS` in config) |
| **Rebalance cadence** | **Sunday 06:00–06:10 ET** — screener ranks on **Friday** OHLCV (last completed session). **Stop** evaluation runs **Tue–Sat 06:00–06:10 ET**. **Monday** skips. | `scheduler.ts`, `daily-workflow.ts` |
| **WATCHLIST bench cap** | `WATCHLIST` rows carry no entry / stop / sizing. **topN BUY cap (3)** is absolute — `WATCHLIST` must never open `positions`. | `momentum-screener.ts`, `telegram-dispatcher.ts`, `WATCHLIST_BENCH_DEPTH` |
| **Corporate actions** | `cue adjust-splits` after **ingest** on both pipeline routes. **`critical: false`**. Idempotent via `corporate_actions` UNIQUE. | `src/ingestors/corporate-actions.ts`, `daily-workflow.ts` |
| **Backtest reference** | Dashboard pins to `WHERE strategy = 'MOMENTUM' AND locked = 1`. New runs default **unlocked**. Lock requires explicit migration backfill after gate ceremony. | `src/briefing/queries.ts`, migration `009` |
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
| **Fetcher currency guard** | Per ticker: `MAX(date)` in `daily_prices` vs expected last ET session. `--force` bypasses. | `src/ingestors/massive-price-ingestor.ts` |
| **T-1 ingest default** | Ingestor resolves previous ET weekday (`previousWeekdayBeforeEtCivil`) unless `--date` is explicit. Auto-backfill covers last 5 weekdays after primary insert (universe runs only; only dates `< primarySessionDate` attempted). | `src/ingestors/massive-price-ingestor.ts` |
| **Data lag accepted** | Massive EOD may lag 1–2 sessions. | Operational assumption |
| **Yahoo context TTL** | Cache policy in Yahoo bundle fetch. | `src/llm/yahooContext.ts` |

---

## Alert guardrails

| Guardrail | Rule | Enforced in |
|---|---|---|
| **SELL alerts fire on both modes** | `brief --mode stop` and `--mode rebalance` both dispatch SELL alerts first (before BUY alerts or Daily Pulse). Same-day artefacts (`exit_date = entry_date`) excluded from `listSellSignalsReadyToAlert`. | `src/briefing/telegram-dispatcher.ts`, `src/briefing/queries.ts` |
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
| **Post-pipeline healthcheck** | `cue healthcheck` is independent of the morning chain; Telegram on pass/fail; exit **1** on any failed check or Telegram delivery failure. Cron should fire after 06:00 ET window. | `src/agents/healthcheck.ts` |
| **Scheduler idempotency** | At most one **successful** run per ET `YYYY-MM-DD` in window; key set only on pipeline exit **0**. | `pipeline_state` + `src/db/queries.ts` (`getPipelineState` / `setPipelineState`), `src/agents/scheduler.ts` |
| **Concurrency lock** | In-process **`isRunning`** plus **`LOCK_PATH`** PID file (`process.kill(pid, 0)` stale clear) so PM2 restarts cannot leave a false “idle” while another instance holds the pipeline. | `src/agents/scheduler.ts` |
| **Mode / flag orthogonality** | `--force-rebalance` vs calendar **Saturday**; `--now` only on `pipeline` for one-shot registry run. | `daily-workflow.ts`, CLI |

---

## Position management guardrails

| Guardrail | Rule | Enforced in |
|---|---|---|
| **Max concurrent positions** | Bounded by screener + `MAX_POSITIONS` policy. | `momentum-screener.ts`, config |
| **Stops persisted** | OPEN rows maintain `current_stop_loss` / `highest_close_since_entry` in DB. | `positions` table + screener / queries |
| **Stop replay anchored to `lastEvaluatedDate`** | `replayExitReason` seeds `currentStop` from DB-persisted `COALESCE(current_stop_loss, initial_atr_stop)` and starts its loop from the bar **after** `MAX(stop_movements.as_of_date)` (falling back to `entry_date`). Re-walking already-evaluated bars with an evolved stop is forbidden. | `src/analysers/momentum-screener.ts` |
| **Ratchet `nextHigh` over all unevaluated bars** | The stop-mode ratchet computes `nextHigh` as `max(prevHigh, close)` over **all** bars from `lastEvaluatedDate` (exclusive) through `asOf` (inclusive), not just the single `asOf` bar. Ensures missed peaks are recovered on the next run after a pipeline gap. | `src/analysers/momentum-screener.ts` |
| **No new BUYs in bear regime** | BUY signals not emitted when QQQ below SMA200 on rebalance path. | `momentum-screener.ts` |

---

## New strategy guardrails

| Guardrail | Rule |
|-----------|------|
| **Backtest before production code** | No new production screener without multi-year backtest gates (CAGR>12%, MaxDD<20%, Sharpe>1.0, Expectancy>0). |
| **Signal type isolation** | `signals.signal_type` distinguishes strategies (default `MOMENTUM`). |
| **No surprise data sources** | New data vendors require architecture + reliability review before any code lands. |
