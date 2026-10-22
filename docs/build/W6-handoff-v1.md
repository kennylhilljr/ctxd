# W6 handoff v1

## Commits

- One commit on this branch: the search benchmark fixtures, harness, `npm run bench:search`, the CI regression check, and a real bug fix found while building it.

Branch `done/w6-search-benchmark`, on top of `main`. Nothing was pushed and no pull request was opened; that is the owner's step per the kickoff plan.

## Delivered

**The fixtures** (`test/fixtures/search-bench/`): 25 invented topics (deploys, caching, incident response, onboarding, and so on), each realized across 8 invented scopes and 8 entry kinds, for 200 corpus entries. Each topic carries three labeled queries: a keyword query using the entry's own vocabulary, a paraphrase query with the same meaning and deliberately no shared salient words, and a mixed query with partial overlap — 75 labeled queries total, each with its topic's 8 entries as the relevant set. `embeddings.json` holds precomputed vectors for every entry and query from the pinned model (`Xenova/all-MiniLM-L6-v2` @ `751bff37182d3f1213fa05d7196b954e230abad9`), generated once by `scripts/gen-search-bench-embeddings.ts`; that script is the only part of this slice that touches the network. `scripts/gen-search-bench-fixtures.ts` regenerates `corpus.json`/`queries.json` deterministically if the topic set ever changes.

**The harness** (`src/bench/searchBench.ts`): builds a throwaway database from the fixtures (every corpus entry written through the real `writeEntry`, every precomputed vector loaded directly into `embeddings`/`embeddings_vec0`, exactly as a vector arriving through sync would), then runs every labeled query through the real `runSearch` in keyword-only and hybrid mode, scoring MRR@10, nDCG@10 and recall@10 against each query's labeled relevant set. Hybrid mode never touches the network or the real model: a marker file at the pinned model's expected weight path satisfies `isModelCached` (it only checks existence and size, the same trick `test/unit/doctor.test.ts` already uses), and `runSearch`'s injected `loadEmbedderFn` serves each query's precomputed vector instead of running inference.

**`npm run bench:search`** (`scripts/bench-search.ts`) prints both modes' metrics overall and by query type, and the paraphrase-query delta. `--write-baseline` records hybrid's current numbers to `test/fixtures/search-bench/baseline.json`.

**The CI check** (`test/unit/search-bench.test.ts`, part of `npm test`): fails if hybrid's overall MRR, nDCG or recall drops more than 0.03 below the recorded baseline, and separately asserts hybrid beats keyword-only on paraphrase queries specifically — not only a regression guard, but a standing check on M5's actual exit criterion.

**A real bug, found and fixed while building the fixtures:** `runSearch`'s scored-search path (`src/search/fts.ts`) passed a free-text query straight into FTS5's `MATCH` with no escaping. FTS5's query string is its own small expression language (`-`, `"`, `(`, `)`, `*`, `:`, `OR`/`AND`/`NOT`), so a query containing one of those characters throws a raw `SqliteError` instead of returning results — found when the "blue-green deployment rollback" keyword query crashed the benchmark outright. This is not benchmark-specific: any real `context_search` call with ordinary punctuation in it (`"self-hosted"`, `"don't"`, a literal quote) hits the same crash in production today. Fixed with `escapeFtsQuery`, which wraps each whitespace-separated word in its own quoted phrase (doubling any literal `"`), keeping the same implicit-AND-of-terms behavior for an ordinary query. Regression tests in `test/unit/hybrid-search.test.ts` cover both the hyphen and the literal-quote case.

## Results: does hybrid beat keyword-only on paraphrase queries?

**Yes, by a wide margin**, without regressing keyword queries:

| | keyword-only | hybrid |
|---|---|---|
| overall MRR@10 / nDCG@10 / recall@10 | 0.293 / 0.293 / 0.293 | 0.977 / 0.946 / 0.937 |
| keyword queries (n=25) | 0.840 / 0.840 / 0.840 | 1.000 / 0.993 / 0.990 |
| paraphrase queries (n=25) | 0.000 / 0.000 / 0.000 | 0.930 / 0.884 / 0.875 |
| mixed queries (n=25) | 0.040 / 0.040 / 0.040 | 1.000 / 0.961 / 0.945 |

Keyword-only search scores exactly zero on paraphrase queries by construction: each paraphrase query was deliberately written to share no salient vocabulary with its topic's entries, so bm25 has nothing to match on. Hybrid recovers almost all of that (nDCG@10 0.884) through the vector side of reciprocal rank fusion, while keyword-matching queries lose essentially nothing (0.993 vs. 0.840 — hybrid is *better* here too, likely because importance and the vector signal break bm25 ties that keyword-only leaves as near-ties). This is the result the M5 exit criterion asked to see measured, and it holds up: hybrid is measurably, substantially better on paraphrase queries, not just non-worse.

No tuning was done to produce this result; the fixtures were written once, embedded once, and the benchmark run against them as built.

## Verification

`npm run typecheck` and `npm test`: 740 of 740 tests passing across 66 files (up from 735, reflecting the two new test files this slice adds).

- `test/unit/search-bench.test.ts`: baseline file exists, hybrid does not regress below it, hybrid beats keyword-only on paraphrase queries. All offline, using only the committed fixtures.
- `test/unit/hybrid-search.test.ts`: two new regression cases for the FTS5 escaping fix (a hyphenated query, a query with a literal double quote), plus all of this file's existing hybrid-relevance tests still passing unchanged.
- `npx tsx scripts/bench-search.ts` run by hand, output captured above; `--write-baseline` run once to record `baseline.json`.

Not run: a real model download inside this repository's own CI (if it has one) — `scripts/gen-search-bench-embeddings.ts` is a by-hand fixture generator, not part of `npm test` or `npm run bench:search`, exactly so the committed `embeddings.json` is all either ever needs.

## What was not done and why

Nothing from W6's scope was skipped. The task's fallback ("If it does not [beat keyword-only], say so and propose tuning") did not apply, since hybrid did beat keyword-only; no tuning was attempted or needed.

## Owner steps

None specific to this slice. If the fixture topics ever need to change, regenerate in order: `npx tsx scripts/gen-search-bench-fixtures.ts`, then `npx tsx scripts/gen-search-bench-embeddings.ts` (needs the network once), then `npm run bench:search -- --write-baseline` to record a new baseline.
