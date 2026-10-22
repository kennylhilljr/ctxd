/**
 * W6: the search quality benchmark's shared logic, used by both `scripts/bench-search.ts` (the
 * human-facing `npm run bench:search` report) and `test/unit/search-bench.test.ts` (the CI
 * regression check). Builds a throwaway database from `test/fixtures/search-bench/`'s corpus and
 * precomputed embeddings, runs the real `runSearch` (src/search/fts.ts) in keyword-only and
 * hybrid modes, and scores each against the fixture's labeled relevant sets with MRR@10, nDCG@10
 * and recall@10.
 *
 * Hybrid mode never calls the real model: a marker file at the pinned model's expected weight
 * path satisfies `isModelCached` (it only checks existence and non-zero size, the same trick
 * `test/unit/doctor.test.ts`'s checkSemanticSearch tests already use), and `runSearch`'s injected
 * `loadEmbedderFn` returns each query's precomputed vector instead of running real inference.
 * Corpus vectors go straight into `embeddings`/`embeddings_vec0`, exactly as a synced vector from
 * another node would (src/embed/compute.ts's own comment: two nodes computing the same model_id
 * for the same text produce the same vector). Nothing here reaches the network or loads the real
 * model at benchmark-run time.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { HlcClock } from "../core/hlc.js";
import { newId } from "../core/ids.js";
import { openDatabase } from "../store/db.js";
import { writeEntry, type WriteContext } from "../store/write.js";
import { runSearch } from "../search/fts.js";
import { upsertVecIndex } from "../embed/vec.js";
import { FULL_MODEL_ID } from "../embed/compute.js";
import { EMBEDDING_DIM, MODEL_ID, MODEL_REVISION, modelCacheDir, type Embedder } from "../embed/model.js";
import { parseRef } from "../model/refs.js";
import type { RequestContext } from "../server/context.js";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "test", "fixtures", "search-bench");
export const BASELINE_PATH = join(FIXTURES_DIR, "baseline.json");
/** How far hybrid may drop below its recorded baseline before the CI check fails. */
export const REGRESSION_MARGIN = 0.03;

export interface CorpusEntry {
  id: string;
  topic: string;
  scope: string;
  kind: string;
  title: string;
  body: string;
}

export type QueryType = "keyword" | "paraphrase" | "mixed";

export interface LabeledQuery {
  id: string;
  topic: string;
  type: QueryType;
  query: string;
  relevant: string[];
}

export interface EmbeddingFixtures {
  entries: Record<string, number[]>;
  queries: Record<string, number[]>;
}

export interface BenchFixtures {
  corpus: CorpusEntry[];
  queries: LabeledQuery[];
  embeddings: EmbeddingFixtures;
}

export function loadFixtures(): BenchFixtures {
  const corpus = JSON.parse(readFileSync(join(FIXTURES_DIR, "corpus.json"), "utf8")) as CorpusEntry[];
  const queries = JSON.parse(readFileSync(join(FIXTURES_DIR, "queries.json"), "utf8")) as LabeledQuery[];
  const embeddings = JSON.parse(readFileSync(join(FIXTURES_DIR, "embeddings.json"), "utf8")) as EmbeddingFixtures;
  return { corpus, queries, embeddings };
}

export interface BenchDb {
  db: Database.Database;
  ctx: RequestContext;
  /** Fixture corpus id -> the real ULID writeEntry assigned it. */
  fixtureToReal: Map<string, string>;
  /** The real ULID -> fixture corpus id, for scoring a search result back against `relevant`. */
  realToFixture: Map<string, string>;
}

/** Writes every corpus entry as the human client, then loads its precomputed vector directly into embeddings/embeddings_vec0 (never computed at benchmark time). */
export function buildBenchDb(fixtures: BenchFixtures): BenchDb {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxd-search-bench-db-"));
  const db = openDatabase(join(dataDir, "ctxd.db"), { create: true });
  const nodeId = newId();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'bench', 'home', ?)").run(nodeId, now);
  for (const scope of new Set(fixtures.corpus.map((e) => e.scope))) {
    db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, ?, ?)").run(newId(), scope, now);
  }
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now);

  const wctx: WriteContext = { db, clock: new HlcClock(nodeId), nodeId, clientId: humanId };
  const fixtureToReal = new Map<string, string>();
  const realToFixture = new Map<string, string>();
  for (const entry of fixtures.corpus) {
    const result = writeEntry(wctx, { scope: entry.scope, kind: entry.kind, title: entry.title, body: entry.body, request_id: newId() } as never) as { id: string };
    fixtureToReal.set(entry.id, result.id);
    realToFixture.set(result.id, entry.id);

    const vector = fixtures.embeddings.entries[entry.id];
    if (!vector) throw new Error(`missing precomputed embedding for corpus entry ${entry.id}`);
    db.prepare("INSERT INTO embeddings (entry_id, model_id, dim, vector, rev, updated_hlc) VALUES (?, ?, ?, ?, 'bench', ?)").run(
      result.id,
      FULL_MODEL_ID,
      EMBEDDING_DIM,
      JSON.stringify(vector),
      now,
    );
    upsertVecIndex(db, result.id, FULL_MODEL_ID, EMBEDDING_DIM, vector);
  }

  const ctx: RequestContext = { db, clock: new HlcClock(nodeId), nodeId, clientId: humanId, clientName: "human", vendor: "human", assumedPools: [] };
  return { db, ctx, fixtureToReal, realToFixture };
}

/** A dataDir whose pinned-model weight file exists (any non-empty file: isModelCached only checks size), so hybridRelevance's isModelCached guard passes without a real model. */
function fakeCachedModelDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxd-search-bench-model-marker-"));
  const weightDir = join(modelCacheDir(dataDir), MODEL_ID, MODEL_REVISION, "onnx");
  mkdirSync(weightDir, { recursive: true });
  writeFileSync(join(weightDir, "model_quantized.onnx"), "marker");
  return dataDir;
}

/** Serves each query's precomputed vector by its exact query text, standing in for a real model load. */
function fakeEmbedderFor(fixtures: BenchFixtures): () => Promise<Embedder | null> {
  const byText = new Map(fixtures.queries.map((q) => [q.query, fixtures.embeddings.queries[q.id]!]));
  return async () => ({
    async embed(text: string): Promise<number[]> {
      const vector = byText.get(text);
      if (!vector) throw new Error(`no precomputed query vector for: ${text}`);
      return vector;
    },
  });
}

export interface Metrics {
  mrr: number;
  ndcg: number;
  recall: number;
  n: number;
}

function reciprocalRank(rankedFixtureIds: (string | undefined)[], relevant: Set<string>): number {
  const idx = rankedFixtureIds.findIndex((id) => id !== undefined && relevant.has(id));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

function recallAtK(rankedFixtureIds: (string | undefined)[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = new Set(rankedFixtureIds.slice(0, k));
  let hit = 0;
  for (const id of relevant) if (top.has(id)) hit++;
  return hit / relevant.size;
}

function ndcgAtK(rankedFixtureIds: (string | undefined)[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedFixtureIds.length); i++) {
    const id = rankedFixtureIds[i];
    if (id !== undefined && relevant.has(id)) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(k, relevant.size);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

function emptyMetrics(): Metrics {
  return { mrr: 0, ndcg: 0, recall: 0, n: 0 };
}

function accumulate(into: Metrics, mrr: number, ndcg: number, recall: number): void {
  into.mrr += mrr;
  into.ndcg += ndcg;
  into.recall += recall;
  into.n += 1;
}

function finalize(m: Metrics): Metrics {
  return m.n === 0 ? m : { mrr: m.mrr / m.n, ndcg: m.ndcg / m.n, recall: m.recall / m.n, n: m.n };
}

export interface BenchResult {
  overall: Metrics;
  byType: Record<QueryType, Metrics>;
}

export type BenchMode = "keyword" | "hybrid";

/** Runs every labeled query through the real runSearch in the given mode, scoring top-10 results. */
export async function runBenchmark(fixtures: BenchFixtures, mode: BenchMode): Promise<BenchResult> {
  const { ctx, realToFixture } = buildBenchDb(fixtures);
  const hybridCtx: RequestContext =
    mode === "hybrid" ? { ...ctx, dataDir: fakeCachedModelDataDir(), flags: new Map([["semantic_search", true]]) } : { ...ctx, flags: new Map([["semantic_search", false]]) };
  const loadEmbedderFn = mode === "hybrid" ? fakeEmbedderFor(fixtures) : undefined;

  const overall = emptyMetrics();
  const byType: Record<QueryType, Metrics> = { keyword: emptyMetrics(), paraphrase: emptyMetrics(), mixed: emptyMetrics() };

  for (const q of fixtures.queries) {
    const result = await runSearch(
      hybridCtx,
      { scope: "*", query: q.query, limit: 10, max_tokens: 50_000, include_proposed: true },
      loadEmbedderFn as never,
    );
    const rankedFixtureIds = result.results.map((r) => {
      const parsed = parseRef(r.ref);
      return parsed ? realToFixture.get(parsed.id) : undefined;
    });
    const relevant = new Set(q.relevant);
    const mrr = reciprocalRank(rankedFixtureIds, relevant);
    const ndcg = ndcgAtK(rankedFixtureIds, relevant, 10);
    const recall = recallAtK(rankedFixtureIds, relevant, 10);
    accumulate(overall, mrr, ndcg, recall);
    accumulate(byType[q.type], mrr, ndcg, recall);
  }

  return {
    overall: finalize(overall),
    byType: { keyword: finalize(byType.keyword), paraphrase: finalize(byType.paraphrase), mixed: finalize(byType.mixed) },
  };
}
