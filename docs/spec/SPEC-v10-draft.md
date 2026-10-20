# Spec v10 draft

Working notes collected while the completion kickoff ([docs/build/completion-kickoff-v1.md](../build/completion-kickoff-v1.md)) runs. M7 slice 8 folds this into the numbered Spec v10; until then each workstream appends its own section here instead of editing Spec v9 directly.

## W6: search quality benchmark

Measures M5's never-measured exit criterion: "hybrid search measurably better on a test set."

- **Fixtures** (`test/fixtures/search-bench/`): 25 invented topics x 8 (scope, kind) combinations = 200 corpus entries; 3 labeled queries per topic (keyword, paraphrase, mixed) = 75 labeled queries; `baseline.json`, the recorded regression baseline. `embeddings.json` holds precomputed vectors from the pinned model (`Xenova/all-MiniLM-L6-v2` @ `751bff37...`) for every corpus entry and query, generated once by `scripts/gen-search-bench-embeddings.ts` (the only part of this slice that touches the network); everything else runs offline.
- **`npm run bench:search`** (`scripts/bench-search.ts`, `src/bench/searchBench.ts`): runs the real `runSearch` (11.2) in keyword-only and hybrid modes against a throwaway database built from the fixtures, scoring MRR@10, nDCG@10 and recall@10 overall and by query type. `--write-baseline` records hybrid's current numbers as the new baseline.
- **CI check** (`test/unit/search-bench.test.ts`): fails if hybrid's overall MRR, nDCG or recall drops more than 0.03 below the recorded baseline, and separately asserts hybrid beats keyword-only on paraphrase queries (M5's exit criterion), not just a regression guard.
- **Result:** hybrid measurably beats keyword-only, overwhelmingly on paraphrase queries where bm25 has zero shared vocabulary to match on (nDCG@10 0.884 vs 0.000) and without regressing keyword queries (0.993 vs 0.840). Full numbers in [W6-handoff-v1.md](../build/W6-handoff-v1.md).
- **Bug found and fixed while building the fixtures:** `runSearch`'s scored-search path passed a free-text query straight into FTS5's `MATCH` with no escaping, so a query containing an FTS5 syntax character (a bare hyphen, a literal quote) threw a raw `SqliteError` instead of returning results. Fixed in `src/search/fts.ts` (`escapeFtsQuery`, quoting each whitespace-separated word) with a regression test in `test/unit/hybrid-search.test.ts`. This affects any real query with ordinary punctuation (for example "blue-green" or "self-hosted"), not only the benchmark.
