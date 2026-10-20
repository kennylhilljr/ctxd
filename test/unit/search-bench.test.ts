import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BASELINE_PATH, REGRESSION_MARGIN, loadFixtures, runBenchmark, type Metrics } from "../../src/bench/searchBench.js";

/**
 * W6's CI check: hybrid search must not drop more than REGRESSION_MARGIN below its recorded
 * baseline (test/fixtures/search-bench/baseline.json, written by `npm run bench:search
 * --write-baseline`). Entirely offline: the corpus, queries and their embeddings are all
 * precomputed fixtures; this never loads the real model or reaches the network.
 */

describe("search benchmark (W6)", () => {
  it("has a recorded baseline to check against", () => {
    expect(existsSync(BASELINE_PATH)).toBe(true);
  });

  it("hybrid search does not regress below its recorded baseline", async () => {
    const fixtures = loadFixtures();
    const hybrid = await runBenchmark(fixtures, "hybrid");
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Metrics;

    for (const metric of ["mrr", "ndcg", "recall"] as const) {
      expect(hybrid.overall[metric]).toBeGreaterThanOrEqual(baseline[metric] - REGRESSION_MARGIN);
    }
  });

  it("hybrid beats keyword-only on paraphrase queries (M5's exit criterion)", async () => {
    const fixtures = loadFixtures();
    const keyword = await runBenchmark(fixtures, "keyword");
    const hybrid = await runBenchmark(fixtures, "hybrid");

    expect(hybrid.byType.paraphrase.ndcg).toBeGreaterThan(keyword.byType.paraphrase.ndcg);
  });
}, 30_000);
