/**
 * SEC EDGAR earnings ingestor — fetches historical earnings report dates from
 * the SEC EDGAR submissions API (10-K and 10-Q filing dates).
 *
 * ## How it works
 * 1. Downloads `company_tickers.json` from SEC (maps ticker → CIK), cached locally.
 * 2. For each ticker, fetches `https://data.sec.gov/submissions/CIK##########.json`
 * 3. Filters `filings.recent[].form` for "10-K" and "10-Q" entries
 * 4. Extracts `filingDate` as the earnings report date
 * 5. Stores in `earnings_events` table with source='sec_edgar'
 *
 * Coverage spans the full public trading history (10+ years per ticker).
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import { setPipelineState } from "../db/queries.js";
import { openCueDb } from "../db/provider.js";
import { initSchema } from "../db/schema.js";
import { loadUniverseTickers } from "../universe/load-universe.js";

type SqliteConnection = Database.Database;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** SEC company_tickers.json entry. */
interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** SEC submissions API response (partial, only fields we need). */
interface SecSubmissionsResponse {
  cik: string;
  name: string;
  filings: {
    recent: {
      form: string[];
      filingDate: string[];
      primaryDocument: string[];
      description?: string[];
    };
    files?: Array<{ name: string; filingCount: number }>;
  };
}

// ---------------------------------------------------------------------------
// CIK mapping
// ---------------------------------------------------------------------------

const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

function cikCachePath(cacheDir: string): string {
  return path.resolve(cacheDir, "sec", "company_tickers.json");
}

/** SEC requires a meaningful User-Agent. */
const SEC_USER_AGENT = "CueResearch/1.0 (shubham@cue.ai)";

/**
 * Fetch a URL and return the response body as text.
 * Uses native fetch (Node 18+).
 */
async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": SEC_USER_AGENT, "Accept": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
  }
  return resp.text();
}

/**
 * Load or download the CIK mapping file.
 * Returns Map<ticker (uppercase), 10-digit CIK string>.
 */
export async function loadCikMap(cacheDir: string): Promise<Map<string, string>> {
  const cachePath = cikCachePath(cacheDir);

  let raw: string;
  if (fs.existsSync(cachePath)) {
    const stat = fs.statSync(cachePath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 24 * 60 * 60 * 1000) {
      raw = fs.readFileSync(cachePath, "utf-8");
    } else {
      raw = await downloadCikJson(cachePath);
    }
  } else {
    raw = await downloadCikJson(cachePath);
  }

  const parsed: Record<string, CompanyTickerEntry> = JSON.parse(raw);
  const map = new Map<string, string>();
  for (const key of Object.keys(parsed)) {
    const entry = parsed[key]!;
    const cikStr = String(entry.cik_str).padStart(10, "0");
    map.set(entry.ticker.toUpperCase(), cikStr);
  }
  return map;
}

async function downloadCikJson(cachePath: string): Promise<string> {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });

  const text = await fetchText(COMPANY_TICKERS_URL);
  fs.writeFileSync(cachePath, text, "utf-8");
  return text;
}

// ---------------------------------------------------------------------------
// EDGAR submissions fetcher
// ---------------------------------------------------------------------------

/** Fetch SEC submissions for a CIK number. */
async function fetchSubmissions(cik: string): Promise<SecSubmissionsResponse | null> {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  try {
    const text = await fetchText(url);
    return JSON.parse(text) as SecSubmissionsResponse;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`SEC EDGAR: failed to fetch CIK ${cik}: ${msg}`);
    return null;
  }
}

/** Extract 10-K and 10-Q filing dates from a filings.recent block. */
function extractFromRecentBlock(recent: {
  form: string[];
  filingDate: string[];
}): Array<{ reportDate: string; formType: string }> {
  const dates: Array<{ reportDate: string; formType: string }> = [];
  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i]!;
    if (form === "10-K" || form === "10-Q") {
      const filingDate = recent.filingDate[i];
      if (filingDate) {
        dates.push({ reportDate: filingDate, formType: form });
      }
    }
  }
  return dates;
}

/**
 * Fetch a historical filing file from SEC (for older filings beyond `recent`).
 * Each `file` entry in `filings.files` points to an additional JSON with more filings.
 */
async function fetchHistoricalFilingFile(cik: string, fileName: string): Promise<SecSubmissionsResponse | null> {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json?file=${encodeURIComponent(fileName)}`;
  try {
    const text = await fetchText(url);
    return JSON.parse(text) as SecSubmissionsResponse;
  } catch {
    return null;
  }
}

/** Extract 10-K and 10-Q filing dates from SEC submissions response, including historical files. */
async function extractFilingDates(
  data: SecSubmissionsResponse,
  cik: string,
): Promise<Array<{ reportDate: string; formType: string }>> {
  const allDates: Array<{ reportDate: string; formType: string }> = [];

  // 1. Process recent filings
  if (data.filings?.recent) {
    const recentDates = extractFromRecentBlock(data.filings.recent);
    allDates.push(...recentDates);
  }

  // 2. Process historical filing files (covers data beyond ~4 years)
  const files = data.filings?.files;
  if (files && files.length > 0) {
    for (const file of files) {
      const fileData = await fetchHistoricalFilingFile(cik, file.name);
      if (fileData?.filings?.recent) {
        const historicalDates = extractFromRecentBlock(fileData.filings.recent);
        allDates.push(...historicalDates);
      }
      await delay(100); // rate-limit between historical file fetches
    }
  }

  // Dedup by reportDate and sort
  const seen = new Set<string>();
  const unique: Array<{ reportDate: string; formType: string }> = [];
  for (const d of allDates) {
    if (!seen.has(d.reportDate)) {
      seen.add(d.reportDate);
      unique.push(d);
    }
  }

  unique.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  return unique;
}

// ---------------------------------------------------------------------------
// Pipeline state
// ---------------------------------------------------------------------------

function earningsFetchedKey(ticker: string): string {
  return `sec_earnings_fetched:${ticker}`;
}

/** Delay helper to rate-limit SEC requests. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Single ticker fetch & persist
// ---------------------------------------------------------------------------

/**
 * Fetch and persist earnings events for a single ticker via SEC EDGAR.
 * Skips if already fetched (pipeline state check).
 */
export async function fetchAndPersistEarnings(
  db: SqliteConnection,
  ticker: string,
  cacheDir: string,
): Promise<void> {
  const tickerUpper = ticker.toUpperCase();

  const existing = db
    .prepare(`SELECT id FROM earnings_events WHERE ticker = ? AND source = 'sec_edgar' LIMIT 1`)
    .get(tickerUpper) as { id: number } | undefined;

  if (existing !== undefined) {
    return; // already fetched
  }

  let cikMap: Map<string, string>;
  try {
    cikMap = await loadCikMap(cacheDir);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ${tickerUpper}: failed to load CIK map: ${msg}`);
    return;
  }

  const cik = cikMap.get(tickerUpper);
  if (!cik) {
    console.warn(`  ${tickerUpper}: no CIK mapping found`);
    return;
  }

  console.log(`  ${tickerUpper}: CIK=${cik}, fetching...`);

  const data = await fetchSubmissions(cik);
  if (!data) {
    return;
  }

  const dates = await extractFilingDates(data, cik);
  if (dates.length === 0) {
    console.warn(`  ${tickerUpper}: no 10-K/10-Q filings found`);
    return;
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO earnings_events (ticker, report_date, form_type, source)
     VALUES (?, ?, ?, 'sec_edgar')`,
  );

  const inserted = db.transaction(() => {
    let count = 0;
    for (const d of dates) {
      const result = insert.run(tickerUpper, d.reportDate, d.formType);
      if (result.changes > 0) count++;
    }
    return count;
  })();

  setPipelineState(db, earningsFetchedKey(tickerUpper), String(dates.length));
  console.log(
    `  ${tickerUpper}: inserted ${inserted}/${dates.length} events (${dates[0]!.reportDate} → ${dates[dates.length - 1]!.reportDate})`,
  );

  await delay(250); // rate limit: 4 req/s max
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export interface EarningsIngestorOpts {
  ticker?: string;
  force?: boolean;
}

/**
 * Fetch earnings events for all universe tickers from SEC EDGAR.
 */
export async function runEarningsIngestor(opts?: EarningsIngestorOpts): Promise<void> {
  const config = getConfig();
  const cacheDir = config.CACHE_DIR;
  const db = openCueDb(config.DB_PATH);

  try {
    initSchema(db);

    const tickers = opts?.ticker
      ? [opts.ticker.toUpperCase()]
      : loadUniverseTickers();

    console.log(`\nSEC EDGAR Earnings Ingestor`);
    console.log(`Tickers: ${tickers.length}`);
    console.log(`Cache: ${cacheDir}`);
    console.log("");

    for (const t of tickers) {
      await fetchAndPersistEarnings(db, t, cacheDir);
    }

    const totalRows = db
      .prepare(`SELECT COUNT(*) AS cnt FROM earnings_events WHERE source = 'sec_edgar'`)
      .get() as { cnt: number };
    const tickerCount = db
      .prepare(`SELECT COUNT(DISTINCT ticker) AS cnt FROM earnings_events WHERE source = 'sec_edgar'`)
      .get() as { cnt: number };
    const range = db
      .prepare(
        `SELECT MIN(report_date) AS lo, MAX(report_date) AS hi FROM earnings_events WHERE source = 'sec_edgar'`,
      )
      .get() as { lo: string | null; hi: string | null };

    console.log(`\nDone: ${totalRows.cnt} events across ${tickerCount.cnt} tickers`);
    console.log(`Range: ${range.lo ?? "N/A"} → ${range.hi ?? "N/A"}`);
  } finally {
    db.close();
  }
}
