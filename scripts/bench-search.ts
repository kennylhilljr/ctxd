/**
 * `npm run bench:search` (W6): prints MRR@10, nDCG@10 and recall@10 for keyword-only and hybrid
 * search over the fixture corpus, overall and by query type. `--write-baseline` records hybrid's
 * overall numbers as the new regression baseline (test/fixtures/search-bench/baseline.json),
 * read by both this script and test/unit/search-bench.test.ts's CI check.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BASELINE_PATH, REGRESSION_MARGIN, loadFixtures, runBenchmark, type Metrics } from "../src/bench/searchBench.js";

function row(label: string, m: Metrics): string {
  return `${label.padEnd(12)} mrr=${m.mrr.toFixed(3)}  ndcg=${m.ndcg.toFixed(3)}  recall=${m.recall.toFixed(3)}  (n=${m.n})`;
}

async function main(): Promise<void> {
  const writeBaseline = process.argv.includes("--write-baseline");
  const fixtures = loadFixtures();

  const keyword = await runBenchmark(fixtures, "keyword");
  const hybrid = await runBenchmark(fixtures, "hybrid");

  console.log(`Search benchmark: ${fixtures.corpus.length} entries, ${fixtures.queries.length} labeled queries\n`);
  console.log("keyword-only search:");
  console.log("  " + row("overall", keyword.overall));
  for (const type of ["keyword", "paraphrase", "mixed"] as const) console.log("  " + row(type, keyword.byType[type]));
  console.log("\nhybrid search:");
  console.log("  " + row("overall", hybrid.overall));
  for (const type of ["keyword", "paraphrase", "mixed"] as const) console.log("  " + row(type, hybrid.byType[type]));

  const paraphraseDelta = hybrid.byType.paraphrase.ndcg - keyword.byType.paraphrase.ndcg;
  console.log(`\nhybrid vs keyword-only on paraphrase queries: nDCG@10 ${paraphraseDelta >= 0 ? "+" : ""}${paraphraseDelta.toFixed(3)}`);

  if (writeBaseline) {
    writeFileSync(BASELINE_PATH, JSON.stringify(hybrid.overall, null, 2));
    console.log(`\nwrote new baseline to ${BASELINE_PATH}`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.log("\nno baseline recorded yet; run with --write-baseline to record one.");
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Metrics;
  let regressed = false;
  for (const metric of ["mrr", "ndcg", "recall"] as const) {
    if (hybrid.overall[metric] < baseline[metric] - REGRESSION_MARGIN) {
      console.error(`\nREGRESSION: hybrid ${metric} dropped from ${baseline[metric].toFixed(3)} to ${hybrid.overall[metric].toFixed(3)} (margin ${REGRESSION_MARGIN})`);
      regressed = true;
    }
  }
  if (regressed) process.exitCode = 1;
  else console.log(`\nno regression against baseline (margin ${REGRESSION_MARGIN}).`);
}

await main();
