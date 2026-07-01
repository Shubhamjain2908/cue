/**
 * V6 Probe: CORRECT fundamentalsTimeSeries API signatures.
 * Module names: 'balance-sheet', 'financials', 'cash-flow', 'all'
 * Field names: quarterly{FieldName}, annual{FieldName}, trailing{FieldName}
 */
import YahooFinance from "yahoo-finance2";
import fs from "node:fs";
import path from "node:path";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const TICKERS = ["MU", "AAPL", "INTC"];

async function probeFts(ticker: string): Promise<void> {
  const outDir = path.resolve("data/yahoo-probe");
  const period1 = "2019-01-01";
  const period2 = new Date().toISOString().slice(0, 10);

  const MODULES = [
    { module: "balance-sheet", label: "Balance Sheet" },
    { module: "financials", label: "Income Statement" },
    { module: "cash-flow", label: "Cash Flow" },
    { module: "all", label: "All Financials" },
  ];

  for (const { module, label } of MODULES) {
    for (const type of ["annual", "quarterly"] as const) {
      try {
        const data = await yf.fundamentalsTimeSeries(ticker, { period1, period2, type, module });
        if (data) {
          const serialized = JSON.parse(JSON.stringify(data));
          const series = (serialized as any)?.fundamentalsTimeSeries ?? [];
          if (series.length > 0) {
            console.log(`\n  ✅ ${label} (${type}): ${series.length} periods`);
            const first = series[0]!;
            const fields = Object.keys(first).filter(
              k => k !== "maxAge" && k !== "asOfDate" && k !== "periodType" && k !== "dateFormat" && first[k] !== null
            );
            console.log(`     Fields (${fields.length}): ${fields.join(", ")}`);
            // Show last 3 periods with non-zero values
            const recent = series.slice(-3);
            for (const r of recent) {
              const vals = fields
                .filter(f => typeof r[f] === "number" && r[f] !== 0)
                .slice(0, 12)
                .map(f => `${f}=${r[f]}`);
              if (vals.length > 0) {
                console.log(`     ${String(r.asOfDate ?? "").slice(0, 10)}: ${vals.join(", ")}`);
              }
            }
            // Save raw
            const dumpPath = path.join(outDir, `${ticker}_fts_${module}_${type}.json`);
            fs.writeFileSync(dumpPath, JSON.stringify(serialized, null, 2), "utf-8");
          } else {
            console.log(`  ⚠️  ${label} (${type}): empty`);
          }
        }
        await new Promise(r => setTimeout(r, 800));
      } catch (e: any) {
        console.log(`  ❌ ${label} (${type}): ${e?.message ?? e}`);
      }
    }
  }
}

async function probeAllPrecomputed(ticker: string): Promise<void> {
  try {
    const qs = await yf.quoteSummary(ticker, {
      modules: ["financialData", "defaultKeyStatistics", "summaryDetail", "calendarEvents", "assetProfile", "earningsHistory", "fundOwnership"]
    });
    const raw = JSON.parse(JSON.stringify(qs));
    const dumpPath = path.resolve(`data/yahoo-probe/${ticker}_precomputed.json`);
    fs.writeFileSync(dumpPath, JSON.stringify(raw, null, 2), "utf-8");
    console.log(`  ✅ Pre-computed data saved`);
  } catch (e: any) {
    console.log(`  ❌ Precomputed: ${e?.message ?? e}`);
  }
}

async function main(): Promise<void> {
  const tickerIdx = process.argv.indexOf("--ticker");
  const tickers = tickerIdx >= 0 ? [process.argv[tickerIdx + 1]!.toUpperCase()] : TICKERS;

  for (const t of tickers) {
    console.log(`\n${"═".repeat(72)}`);
    console.log(`🔍 V6 CORRECTED PROBE: ${t}`);
    console.log(`${"═".repeat(72)}`);

    await probeAllPrecomputed(t);
    await probeFts(t);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log("✅ V6 probe complete.");
  console.log(`${"═".repeat(72)}`);
}

main().catch(console.error);
