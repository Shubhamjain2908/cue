# Cue — Guardrails
*v1.2 · May 2026 — paths aligned to this repository*

Guardrails are hard constraints. They are not configurable at runtime and must
not be bypassed without an explicit gate override (documented in
`spec/cue-architecture-v1.md` + **`.cursor/rules/project-spec.md`** + committed to repo).

---

## Strategy guardrails (LOCKED)

| Guardrail | Rule | Enforced in |
|---|---|---|
| **Regime gate — BUY suppression** | If QQQ close < SMA(200): suppress all new BUY signals. SELL and stop evaluation run unconditionally. | `src/analysers/momentum-screener.ts` |
| **Top-N hard cap** | At most **3** momentum BUY entries per rebalance pass (`topN = 3` contract). | `src/analysers/momentum-screener.ts` (portfolio cap also tied to `MAX_POSITIONS` in config) |
| **Rebalance vs stop** | Full **BUY** ranking on **`rebalance`** / Friday scheduler path; **stop** path runs maintenance (`execute-stops`) without Friday-style screen. | `src/agents/scheduler.ts`, `src/agents/daily-workflow.ts` (`detectRunMode`) |
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
| **BUY message derivation is local-only** | Entry range / stop / 1R / share count come from the `signals` row, optional `enrichments` join, and `getConfig()` — no new tables, env vars, or external data sources. | `src/briefing/telegram-dispatcher.ts`, `src/briefing/queries.ts` |
| **Stop-path Daily Pulse always fires** | `cue brief --mode stop` sends the Daily Pulse regardless of sell count; rebalance path behavior is unchanged. | `src/briefing/telegram-dispatcher.ts` |
| **Pulse tolerance for missing bars** | If an OPEN ticker has no `daily_prices` row for the resolved pulse `asOf`, skip that ticker with a warning; do not fail the whole pulse. | `src/briefing/telegram-dispatcher.ts`, `src/briefing/queries.ts` |
| **Alert dedup** | `signals.alerted` updated after send. | `src/db/queries.ts`, dispatcher |

---

## Pipeline guardrails

| Guardrail | Rule | Enforced in |
|---|---|---|
| **Critical step abort** | Non-zero exit on critical step aborts chain. | `src/agents/daily-workflow.ts` (`runPipelineWithSteps`) |
| **Non-critical continuation** | enrich / brief failures logged; chain policy per step `critical` bit. | `daily-workflow.ts` |
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
