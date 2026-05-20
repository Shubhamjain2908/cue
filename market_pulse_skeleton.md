# Market Pulse — structural blueprint (skeleton)

This document captures **directory layout**, **swappable LLM contract**, **daily pipeline orchestration**, and **core integration interfaces** for porting the architecture to a parallel system (e.g. US equities). It intentionally omits strategy implementations, screen criteria, and market-specific broker or flow-data logic.

---

## `src/` directory tree

Complete ASCII tree of TypeScript/SQL sources under `src/` (excluding `.DS_Store`).

```
src/
├── agents/
│   ├── backtester.ts
│   ├── briefing-composer.ts
│   ├── daily-ingestor.ts
│   ├── daily-workflow.ts
│   ├── live-scanner.ts
│   ├── portfolio-analyser.ts
│   ├── portfolio-sync.ts
│   ├── portfolio-trigger.ts
│   ├── regime-agent.ts
│   ├── run-summary.ts
│   ├── signal-enricher.ts
│   ├── stock-screener.ts
│   ├── stop-loss-detector.ts
│   ├── thesis-generator.ts
│   └── trailing-stop-postmortem.ts
├── analysers/
│   ├── alerts.ts
│   ├── engine.ts
│   ├── evaluator.ts
│   ├── index.ts
│   ├── regime-classifier.ts
│   └── signal-provider.ts
├── auth/
│   └── kite-auth-server.ts
├── backtest/
│   ├── harness.ts
│   ├── index.ts
│   └── metrics.ts
├── briefing/
│   ├── delivery/
│   │   ├── email.ts
│   │   └── file.ts
│   ├── composer.ts
│   ├── dispatch.ts
│   ├── index.ts
│   ├── momentum-card.ts
│   ├── paper-trade-parsers.ts
│   ├── paper-trade-writer.ts
│   ├── regime-card.ts
│   ├── sector-classifier.ts
│   ├── template.ts
│   └── trailing-stop-card.ts
├── config/
│   ├── env.ts
│   ├── loaders.ts
│   └── project-paths.ts
├── db/
│   ├── migrations/
│   │   ├── 0002_add_theses_table.sql
│   │   ├── 0003_screens_alerts_backtest.sql
│   │   ├── 0004_kite_portfolio_intraday.sql
│   │   ├── 0005_paper_trades.sql
│   │   ├── 0006_regime_tables.sql
│   │   ├── 0007_adaptive_trailing_stop.sql
│   │   ├── 0008_trailing_stop_log_notes.sql
│   │   ├── 0009_momentum_indexes_and_earnings.sql
│   │   ├── 0010_momentum_rebalance_briefing.sql
│   │   ├── 0011_momentum_rebalance_briefing_extended.sql
│   │   ├── 0012_config_table.sql
│   │   └── 0013_corporate_actions.sql
│   ├── connection.ts
│   ├── index.ts
│   ├── migrate.ts
│   ├── momentum-queries.ts
│   ├── portfolio-queries.ts
│   ├── queries.ts
│   ├── regime-queries.ts
│   ├── schema.sql
│   └── trailing-stop-queries.ts
├── enrichers/
│   ├── sentiment/
│   │   └── enricher.ts
│   ├── technical/
│   │   ├── enricher.ts
│   │   └── indicators.ts
│   ├── index.ts
│   ├── momentum-signals.ts
│   └── regime-signals.ts
├── ingestors/
│   ├── base/
│   │   ├── dates.ts
│   │   ├── http-client.ts
│   │   └── rate-limiter.ts
│   ├── kite/
│   │   ├── auth.ts
│   │   ├── client.ts
│   │   └── types.ts
│   ├── nse/
│   │   ├── cookie-jar.ts
│   │   ├── ingestor.ts
│   │   └── types.ts
│   ├── rss/
│   │   ├── feeds.ts
│   │   └── ingestor.ts
│   ├── screener/
│   │   ├── debug-parse.ts
│   │   ├── ingestor.ts
│   │   └── parser.ts
│   ├── yahoo/
│   │   ├── earnings-ingestor.ts
│   │   └── ingestor.ts
│   ├── bootstrap.ts
│   ├── corporate-actions.ts
│   ├── index.ts
│   ├── registry.ts
│   └── types.ts
├── llm/
│   ├── providers/
│   │   ├── anthropic.ts
│   │   ├── cursor-agent.ts
│   │   ├── google-studio.ts
│   │   ├── mock.ts
│   │   ├── openai.ts
│   │   └── vertex.ts
│   ├── factory.ts
│   ├── index.ts
│   ├── json.ts
│   └── types.ts
├── market/
│   ├── benchmarks.ts
│   ├── global-cues.ts
│   ├── ingest-symbols.ts
│   ├── instrument-sector-heuristic.ts
│   ├── nse-calendar.ts
│   ├── quote-change.ts
│   ├── screener-symbol-skip.ts
│   ├── trading-days.ts
│   ├── yahoo-sectors.ts
│   └── yahoo-ticker.ts
├── rankers/
│   └── momentum-ranker.ts
├── scheduler/
│   └── market-scheduler.ts
├── scripts/
│   ├── evaluate-trades.ts
│   └── trailing-stop-engine.ts
├── strategies/
│   └── momentum-rebalance.ts
├── types/
│   ├── domain.ts
│   ├── regime.ts
│   └── trailing-stop.ts
├── cli.ts
├── constants.ts
└── logger.ts
```

### Layer roles (skeleton)

| Area | Role |
|------|------|
| `agents/` | High-level stages: ingest orchestration, regime, screening, thesis, briefing composition, portfolio hooks, daily workflow entry. |
| `ingestors/` | Pluggable data sources behind a shared `Ingestor` contract; `registry` / `bootstrap` wire runs. |
| `enrichers/` | Signal writers (technical class; other modules are functional pipelines reading/writing SQLite). |
| `analysers/` | Screen engine + signal lookup abstraction + regime classification + alerts. |
| `db/` | SQLite integration bus: migrations, prepared statements, typed query modules. |
| `briefing/` | HTML/text composition, templates, delivery adapters. |
| `llm/` | Provider interface + factory + concrete providers. |
| `config/` | Zod-validated env and JSON loaders (watchlist, screens, gates). |
| `scheduler/` | Cron-style scheduling of CLI-equivalent jobs. |
| `cli.ts` | Thin command wiring into agents and stages. |

---

## Production dependencies (`package.json`, excluding `devDependencies`)

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.91.1",
    "@google-cloud/vertexai": "^1.12.0",
    "@google/genai": "^2.0.0",
    "better-sqlite3": "^11.5.0",
    "cheerio": "^1.2.0",
    "commander": "^12.1.0",
    "croner": "^9.0.0",
    "dotenv": "^16.4.5",
    "express": "^5.2.1",
    "got": "^14.6.6",
    "juice": "^11.1.1",
    "nodemailer": "^8.0.7",
    "openai": "^6.35.0",
    "p-limit": "^6.2.0",
    "pino": "^9.5.0",
    "pino-pretty": "^11.3.0",
    "rss-parser": "^3.13.0",
    "tough-cookie": "^5.1.2",
    "yahoo-finance2": "^3.14.0",
    "zod": "^3.23.8"
  }
}
```

---

## LLM provider contract

There is **no** `src/llm/provider.ts`. The canonical contract is **`src/llm/types.ts`** (`LlmProvider` and related option/result types). Implementations live under `src/llm/providers/`. **`src/llm/factory.ts`** exposes `getLlmProvider()` as the single resolution point from config.

### `src/llm/types.ts` (full)

```typescript
/**
 * LLM provider contract. Designed so we can swap between cursor-agent CLI,
 * Anthropic, Vertex (Gemini) and OpenAI without changing prompt code.
 *
 * All methods accept an optional AbortSignal so we can cancel long-running
 * generations when the cron job times out or the CLI is interrupted.
 */

import type { ZodType, ZodTypeDef } from 'zod';

export interface GenerateTextOptions {
  /** System prompt - persona and constraints. */
  system: string;
  /** User prompt - the actual task/data. */
  user: string;
  /** Sampling temperature. Defaults to 0.2 for analytical tasks. */
  temperature?: number;
  /** Hard cap on output tokens. Provider-specific. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateJsonOptions<T> extends GenerateTextOptions {
  /** Zod schema the response must conform to. */
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** Number of repair attempts on parse/validation failure. Default: 1. */
  maxRetries?: number;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

export interface LlmTextResult {
  text: string;
  usage: LlmUsage;
  model: string;
}

export interface LlmJsonResult<T> {
  data: T;
  /** Raw text returned by the model, kept for audit/debugging. */
  raw: string;
  usage: LlmUsage;
  model: string;
}

export interface LlmProvider {
  /** Stable id, e.g. 'cursor-agent' | 'anthropic' | 'vertex' | 'openai'. */
  readonly name: string;
  /** Resolved model identifier - useful for logs and persistence. */
  readonly model: string;

  generateText(opts: GenerateTextOptions): Promise<LlmTextResult>;
  generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>>;
}
```

### `src/llm/factory.ts` (resolution pattern)

```typescript
/**
 * LLM provider factory. Resolves the active provider from env config.
 * The factory is the only place that knows which providers exist - the rest
 * of the codebase consumes the `LlmProvider` interface.
 */

import { config } from '../config/env.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { CursorAgentProvider } from './providers/cursor-agent.js';
import { MockLlmProvider } from './providers/mock.js';
import { OpenAIProvider } from './providers/openai.js';
import { VertexProvider } from './providers/vertex.js';
import type { LlmProvider } from './types.js';
import { GoogleStudioProvider } from "./providers/google-studio.js";

let cached: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (cached) return cached;
  cached = createLlmProvider();
  return cached;
}

/** Force a specific provider, mostly used in tests. */
export function setLlmProvider(provider: LlmProvider): void {
  cached = provider;
}

/** Reset the cache - useful after env changes in tests. */
export function resetLlmProvider(): void {
  cached = null;
}

function createLlmProvider(): LlmProvider {
  switch (config.LLM_PROVIDER) {
    case 'cursor-agent':
      return new CursorAgentProvider();
    case 'anthropic':
      return new AnthropicProvider();
    case 'vertex':
      return new VertexProvider();
    case 'openai':
      return new OpenAIProvider();
    case 'google-studio':
      return new GoogleStudioProvider();
    case 'mock':
      return new MockLlmProvider();
    default: {
      const exhaustive: never = config.LLM_PROVIDER;
      throw new Error(`Unsupported LLM_PROVIDER: ${exhaustive}`);
    }
  }
}
```

---

## Core pipeline orchestrator

**`src/agents/daily-workflow.ts`** — shared by `pnpm daily` and the scheduler. Stages call into other agent modules; swap calendar, universe, portfolio, and ingest implementations for another market while preserving phase order and closure/holiday behavior.

### `src/agents/daily-workflow.ts` (full)

```typescript
/**
 * Reusable full daily workflow orchestration.
 *
 * Shared by:
 *  - `mp daily`
 *  - scheduler jobs (`mp schedule`)
 */

import { config } from '../config/env.js';
import { getMomentumUniverseSymbols } from '../config/loaders.js';
import { getDb } from '../db/index.js';
import { enrichSentiment } from '../enrichers/sentiment/enricher.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { applyCorporateActionsFromYahooSplits } from '../ingestors/corporate-actions.js';
import { syncMomentumEarningsCalendarFromYahoo } from '../ingestors/yahoo/earnings-ingestor.js';
import { child } from '../logger.js';
import { getMarketClosure, isSundayIst } from '../market/nse-calendar.js';
import { runEvaluatePaperTrades } from '../scripts/evaluate-trades.js';
import { applyMomentumRegimeGateExits } from '../strategies/momentum-rebalance.js';
import { runBriefingComposer } from './briefing-composer.js';
import { runDailyIngestor } from './daily-ingestor.js';
import { analysePortfolio } from './portfolio-analyser.js';
import { runPortfolioSync } from './portfolio-sync.js';
import { runRegimeAgent } from './regime-agent.js';
import { maybeWriteDailyRunSummary } from './run-summary.js';
import { runSignalEnricher } from './signal-enricher.js';
import { runStockScreener } from './stock-screener.js';
import { detectStopLossBreaches } from './stop-loss-detector.js';
import { generateTheses } from './thesis-generator.js';

const log = child({ component: 'daily-workflow' });

export interface DailyWorkflowOptions {
  date?: string;
  skipAi?: boolean;
  skipPortfolio?: boolean;
}

export interface DailyWorkflowResult {
  date: string;
  alertCount: number;
  screenMatchesCount: number;
  newsCount: number;
  thesesCount: number;
  portfolioCount: number;
  hasNarrative: boolean;
  html: string;
  delivery: 'file' | 'email' | 'slack' | 'telegram';
  /** True when `date` was a weekend or NSE holiday — no ingest / enrichment / fresh LLMs ran. */
  holidayMode?: boolean;
  /** Human-readable closure label when `holidayMode` is true. */
  marketClosureLabel?: string;
}

export async function runDailyWorkflow(
  opts: DailyWorkflowOptions = {},
): Promise<DailyWorkflowResult> {
  const date = opts.date ?? isoDateIst();

  if (isSundayIst(date)) {
    try {
      await syncMomentumEarningsCalendarFromYahoo(
        getMomentumUniverseSymbols({ fresh: true }),
        getDb(),
        { refDate: date },
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'Sunday Yahoo earnings calendar refresh failed; continuing',
      );
    }
  }

  const closure = getMarketClosure(date);

  if (closure) {
    log.info(
      { date, closure },
      'market closed — persisted-data brief only (no ingest / fresh LLMs)',
    );
    const briefing = await runBriefingComposer({
      date,
      skipAi: true,
      marketClosure: closure,
      delivery: config.BRIEFING_DELIVERY,
    });
    maybeWriteDailyRunSummary({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      date: briefing.date,
      holidayMode: true,
      marketClosureLabel: closure.label,
      delivery: briefing.delivery,
      counts: {
        alerts: briefing.alertCount,
        screenMatchSymbols: briefing.screenMatchesCount,
        news: briefing.newsCount,
        theses: briefing.thesesCount,
        portfolioHoldings: briefing.portfolioCount,
      },
      hasMoodNarrative: briefing.hasNarrative,
    });
    return {
      date: briefing.date,
      alertCount: briefing.alertCount,
      screenMatchesCount: briefing.screenMatchesCount,
      newsCount: briefing.newsCount,
      thesesCount: briefing.thesesCount,
      portfolioCount: briefing.portfolioCount,
      hasNarrative: briefing.hasNarrative,
      html: briefing.html,
      delivery: config.BRIEFING_DELIVERY,
      holidayMode: true,
      marketClosureLabel: closure.label,
    };
  }

  if (!opts.skipPortfolio) {
    try {
      // Phase 4.5: portfolio sync + stop-loss are outside regime gates (`portfolio_exit_signals` /
      // `trailing_stop_update` are always-on at 100% in strategy-gates.json).
      await runPortfolioSync({ date });
      const stopLoss = detectStopLossBreaches({ date });
      log.info(
        { checked: stopLoss.checked, breached: stopLoss.breached },
        'stop-loss detector complete',
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'portfolio sync/stop-loss failed; continuing workflow',
      );
    }
  }

  await runDailyIngestor({ date });
  try {
    await applyCorporateActionsFromYahooSplits(getDb(), { refDate: date });
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'corporate actions from Yahoo splits failed; continuing workflow',
    );
  }
  await runSignalEnricher({ date });
  const regimeAgent = await runRegimeAgent({ date, skipLlm: Boolean(opts.skipAi) });
  const momRegimeExits = applyMomentumRegimeGateExits({
    calendarDate: date,
    regime: regimeAgent.regime,
    db: getDb(),
  });
  if (momRegimeExits > 0) {
    log.info({ momRegimeExits }, 'momentum regime gate: closed paper trades');
  }
  await runStockScreener({ date, regime: regimeAgent.regime });

  let thesisRun:
    | {
        generated: number;
        failed: number;
        candidateCount: number;
        eligibleUniverseSize: number;
        watchlistSize: number;
      }
    | undefined;

  if (!opts.skipAi) {
    const sentimentResult = await enrichSentiment();
    log.info(sentimentResult, 'sentiment scoring done');

    const thesisResult = await generateTheses({
      date,
      maxTheses: config.THESIS_MAX_PER_RUN,
      regime: regimeAgent.regime,
    });
    thesisRun = {
      generated: thesisResult.generated,
      failed: thesisResult.failed,
      candidateCount: thesisResult.candidateCount,
      eligibleUniverseSize: thesisResult.eligibleUniverseSize,
      watchlistSize: thesisResult.watchlistSize,
    };
    log.info(
      { generated: thesisResult.generated, failed: thesisResult.failed },
      'thesis generation done',
    );

    if (!opts.skipPortfolio) {
      const portfolioResult = await analysePortfolio({ date });
      log.info(
        {
          analysed: portfolioResult.analysed,
          failed: portfolioResult.failed,
          byAction: portfolioResult.byAction,
        },
        'portfolio analysis done',
      );
    }
  }

  const paperEval = runEvaluatePaperTrades(date, getDb(), { skipAi: opts.skipAi });
  log.info(paperEval, 'paper trade evaluation');

  const briefing = await runBriefingComposer({
    date,
    skipAi: opts.skipAi,
    thesisRun: opts.skipAi ? undefined : thesisRun,
    delivery: config.BRIEFING_DELIVERY,
  });

  maybeWriteDailyRunSummary({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    date: briefing.date,
    holidayMode: false,
    delivery: briefing.delivery,
    counts: {
      alerts: briefing.alertCount,
      screenMatchSymbols: briefing.screenMatchesCount,
      news: briefing.newsCount,
      theses: briefing.thesesCount,
      portfolioHoldings: briefing.portfolioCount,
    },
    thesisRun: opts.skipAi ? undefined : thesisRun,
    hasMoodNarrative: briefing.hasNarrative,
  });

  return {
    date: briefing.date,
    alertCount: briefing.alertCount,
    screenMatchesCount: briefing.screenMatchesCount,
    newsCount: briefing.newsCount,
    thesesCount: briefing.thesesCount,
    portfolioCount: briefing.portfolioCount,
    hasNarrative: briefing.hasNarrative,
    html: briefing.html,
    delivery: config.BRIEFING_DELIVERY,
  };
}
```

---

## Ingestor contract

**Explicit interface:** `src/ingestors/types.ts`. Domain row types (`Fundamentals`, `NewsItem`, etc.) live in `src/types/domain.ts`; a parallel system would redefine those shapes and optional capabilities (see note below).

### `src/ingestors/types.ts` (full)

```typescript
/**
 * Provider-agnostic Ingestor contract. Every data source (NSE, Yahoo,
 * Screener, Kite, ...) implements a subset of this surface so the pipeline
 * can mix-and-match without changes downstream.
 *
 * Note: not every method is required. A news-only source can implement
 * `fetchNews` and leave the rest as `undefined`.
 */

import type { FiiDiiRow, Fundamentals, NewsItem, RawQuote } from '../types/domain.js';

export interface IngestorContext {
  /** ISO date (YYYY-MM-DD) the pipeline is targeting. Default: today, IST. */
  date?: string;
  /** Universe of symbols the caller cares about. */
  symbols?: string[];
  /** Optional abort signal, used by the CLI on Ctrl+C. */
  signal?: AbortSignal;
}

export interface IngestResult<T> {
  data: T[];
  /** Symbols (or feeds) we couldn't fetch. Logged but non-fatal. */
  failed: string[];
  /** Provider name, useful for breadcrumbs. */
  source: string;
}

export interface Ingestor {
  /** Stable id, e.g. 'nse-eod' or 'kite-tick'. */
  readonly name: string;

  /** The kinds of data this ingestor can produce. */
  readonly capabilities: ReadonlySet<IngestorCapability>;

  /** Lazy initialisation - cookie warm-up, login, etc. Called once per run. */
  init?(ctx: IngestorContext): Promise<void>;

  fetchQuotes?(ctx: IngestorContext): Promise<IngestResult<RawQuote>>;
  fetchFundamentals?(ctx: IngestorContext): Promise<IngestResult<Fundamentals>>;
  fetchNews?(ctx: IngestorContext): Promise<IngestResult<NewsItem>>;
  fetchFiiDii?(ctx: IngestorContext): Promise<IngestResult<FiiDiiRow>>;
}

export type IngestorCapability = 'quotes' | 'fundamentals' | 'news' | 'fii_dii';
```

**Porting note:** Treat `fii_dii` / `fetchFiiDii` / `FiiDiiRow` as **optional market-specific extensions**. A US-equity skeleton can drop that capability and narrow `IngestorCapability` accordingly.

---

## Enricher surface

There is **no single shared `Enricher` interface** in the repo. The closest **explicit class abstraction** is **`TechnicalEnricher`** in `src/enrichers/technical/enricher.ts` (reads quotes, writes rows to `signals`). Other enrichers are **functions** (e.g. `enrichSentiment`, `computeRegimeSignals`, `enrichMomentumSignals`) exported from their modules / `src/enrichers/index.ts`.

### `TechnicalEnricher` — public API (excerpt)

```typescript
export interface TechnicalEnricherOptions {
  /** Lookback window in trading days. Default 260 (~52 weeks + buffer). */
  lookback?: number;
  /** When set, only compute signals for bars on or before this date. */
  asOfDate?: string;
}

export interface EnricherStats {
  symbolsProcessed: number;
  signalsWritten: number;
  symbolsSkipped: number;
}

export class TechnicalEnricher {
  constructor(opts: TechnicalEnricherOptions = {});

  /**
   * Enrich the given symbols. Each symbol is processed independently so
   * one bad symbol can't poison the batch.
   */
  enrich(symbols: string[], db?: DatabaseType): EnricherStats;
}
```

---

## Analyser / screen abstraction

**Explicit interface:** `SignalProvider` in `src/analysers/signal-provider.ts`. The screen **engine** (`runScreenEngine` in `src/analysers/engine.ts`) depends on this abstraction so screens can reference arbitrary flat signal names without knowing storage layout. Default implementation is `DbSignalProvider` (SQLite-backed); tests may use `StaticSignalProvider`.

### `SignalProvider` (interface only)

```typescript
export interface SignalProvider {
  /** Returns the value, or null if the signal isn't available. */
  get(symbol: string, date: string, signal: string): number | null;
}
```

**Screen orchestration:** `runScreenEngine(opts?: ScreenEngineOptions, db?)` in `src/analysers/engine.ts` loads watchlist + screen definitions, evaluates via `SignalProvider`, optionally applies regime gates, and persists to `screens`. Use that module as the **analyser-stage orchestrator** reference, not individual criterion logic in `evaluator.ts`.

---

## Cue-oriented checklist

1. **Calendar / closure** — replace `market/nse-calendar` + IST-centric date helpers with the target market’s session calendar and timezone.
2. **Ingestors** — implement the same `Ingestor` / `IngestResult` pattern with capabilities your sources actually provide.
3. **SQLite bus** — keep “stages read/write explicit tables” pattern; remap `schema.sql` / migrations to US-specific entities where needed.
4. **Regime + gates** — preserve “classify regime → gate strategies → persist audit meta” shape (`regime_strategy_gate` pattern) even if inputs change.
5. **LLM** — keep `LlmProvider` + factory so prompts stay provider-agnostic.

---

*Generated for architectural porting; does not replace reading `AGENTS.md` or domain docs for operational detail.*
