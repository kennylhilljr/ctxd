/**
 * W6: precomputes embeddings for the search benchmark's corpus and queries, from the pinned
 * model (src/embed/model.ts's MODEL_ID @ MODEL_REVISION), so `npm run bench:search` and its CI
 * check run entirely offline afterward. Run by hand only when the fixture set changes:
 * `npx tsx scripts/gen-search-bench-embeddings.ts`. Needs the network once, to fetch the model
 * into a scratch cache dir; nothing here touches the real `~/Library/Application Support/ctxd`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchModel, loadEmbedder } from "../src/embed/model.js";

interface CorpusEntry {
  id: string;
  title: string;
  body: string;
}

interface LabeledQuery {
  id: string;
  query: string;
}

async function main(): Promise<void> {
  const fixturesDir = join(import.meta.dirname, "..", "test", "fixtures", "search-bench");
  const corpus = JSON.parse(readFileSync(join(fixturesDir, "corpus.json"), "utf8")) as CorpusEntry[];
  const queries = JSON.parse(readFileSync(join(fixturesDir, "queries.json"), "utf8")) as LabeledQuery[];

  const scratchDataDir = mkdtempSync(join(tmpdir(), "ctxd-search-bench-model-"));
  console.log(`fetching the pinned model into ${scratchDataDir} ...`);
  await fetchModel(scratchDataDir);
  const embedder = await loadEmbedder(scratchDataDir);
  if (!embedder) throw new Error("model fetch reported success but loadEmbedder still returns null");

  const entries: Record<string, number[]> = {};
  for (const entry of corpus) {
    entries[entry.id] = await embedder.embed(`${entry.title}\n\n${entry.body}`);
  }
  const queryVectors: Record<string, number[]> = {};
  for (const q of queries) {
    queryVectors[q.id] = await embedder.embed(q.query);
  }

  writeFileSync(join(fixturesDir, "embeddings.json"), JSON.stringify({ entries, queries: queryVectors }));
  console.log(`wrote embeddings for ${corpus.length} entries and ${queries.length} queries`);
}

await main();
