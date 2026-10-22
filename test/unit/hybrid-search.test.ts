import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import type { RequestContext } from "../../src/server/context.js";
import { runSearch } from "../../src/search/fts.js";
import { EMBEDDING_DIM, MODEL_ID, MODEL_REVISION, modelCacheDir, type Embedder } from "../../src/embed/model.js";
import { upsertVecIndex } from "../../src/embed/vec.js";
import { FULL_MODEL_ID } from "../../src/embed/compute.js";

/** Places a dummy weight file at the path isModelCached checks, so hybridRelevance's gate passes before the injected fakeLoader takes over. */
function fakeModelCache(dataDir: string): void {
  const file = join(modelCacheDir(dataDir), MODEL_ID, MODEL_REVISION, "onnx", "model_quantized.onnx");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "not a real model, just a presence marker");
}

/**
 * Hybrid search (SPEC v8 11.2's M5 note): reciprocal rank fusion of FTS and vector results.
 * `runSearch`'s `loadEmbedderFn` param is injected with a deterministic fake embedder (a
 * synonym-aware bag-of-words hash) so these tests never need the real model, following the same
 * dependency-injection pattern as doctor.ts's `fetchImpl`/`execFile`.
 */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-hybrid-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  clock: HlcClock;
  nodeId: string;
  humanId: string;
  dataDir: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(newId(), now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    humanId,
    nodeId,
    newId(),
    now(),
  );
  const dataDir = mkdtempSync(join(tmpdir(), "ctxd-hybrid-datadir-"));
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, dataDir };
}

function writeCtx(f: Fixture): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId };
}

function requestCtx(f: Fixture, flags: Map<string, boolean>): RequestContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId, clientName: "human", vendor: "human", assumedPools: [], flags, dataDir: f.dataDir };
}

function note(f: Fixture, title: string, body: string): { id: string } {
  const result = writeEntry(writeCtx(f), { scope: "notes", kind: "note", title, body, request_id: newId() } as never);
  if ("held" in result) throw new Error("unexpected hold");
  return result;
}

const SEMANTIC_SEARCH_ON = new Map([["semantic_search", true]]);

/** Treats "ship"/"launch" as synonyms of "deploy" so two texts can be vector-similar with zero literal word overlap, the thing FTS alone cannot find. */
const SYNONYMS: Record<string, string> = { ship: "deploy", shipping: "deploy", launch: "deploy", launching: "deploy" };

function hashWord(w: string): number {
  let h = 0;
  for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function fakeEmbed(text: string): number[] {
  const vec = new Array(EMBEDDING_DIM).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const w of words) vec[hashWord(SYNONYMS[w] ?? w) % EMBEDDING_DIM] += 1;
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

const fakeEmbedder: Embedder = { embed: async (text: string) => fakeEmbed(text) };
const fakeLoader = async (): Promise<Embedder | null> => fakeEmbedder;

/** Embeds `title`/`body` with the fake embedder and upserts the vec0 index, bypassing the real background job. */
function embedNote(f: Fixture, entry: { id: string }, title: string, body: string): void {
  const vector = fakeEmbed(`${title}\n\n${body}`);
  f.db
    .prepare("INSERT INTO embeddings (entry_id, model_id, dim, vector, rev, updated_hlc) VALUES (?, ?, ?, ?, '1-x', ?)")
    .run(entry.id, FULL_MODEL_ID, EMBEDDING_DIM, JSON.stringify(vector), now());
  upsertVecIndex(f.db, entry.id, FULL_MODEL_ID, EMBEDDING_DIM, vector);
}

describe("runSearch: scored-query FTS5 escaping (regression, found building the W6 search benchmark)", () => {
  it("does not throw on a query containing FTS5 syntax characters, and still matches", async () => {
    const f = setup();
    note(f, "Blue-green deployment rollback", "The blue-green deployment keeps the previous release warm.");

    const result = await runSearch(requestCtx(f, new Map([["semantic_search", false]])), {
      scope: "notes",
      query: "blue-green deployment rollback",
      limit: 10,
      max_tokens: 4000,
      include_proposed: true,
    });
    expect(result.results.map((r) => r.title)).toContain("Blue-green deployment rollback");
  });

  it("does not throw on a query with a literal double quote", async () => {
    const f = setup();
    note(f, "Quoting rules", "How to escape a literal quote character.");

    await expect(
      runSearch(requestCtx(f, new Map([["semantic_search", false]])), {
        scope: "notes",
        query: 'escape a "quote" character',
        limit: 10,
        max_tokens: 4000,
        include_proposed: true,
      }),
    ).resolves.not.toThrow();
  });
});

describe("runSearch: hybrid relevance (semantic_search off, or model not cached)", () => {
  it("falls back to pure FTS, unchanged, when semantic_search is off", async () => {
    const f = setup();
    const a = note(f, "Deploy guide", "How to deploy a new version of sample-app.");
    embedNote(f, a, "Deploy guide", "How to deploy a new version of sample-app.");

    const result = await runSearch(requestCtx(f, new Map([["semantic_search", false]])), {
      scope: "notes",
      query: "deploy",
      limit: 10,
      max_tokens: 4000,
      include_proposed: true,
    });
    expect(result.results.map((r) => r.title)).toEqual(["Deploy guide"]);
  });

  it("falls back to pure FTS when semantic_search is on but the model is not cached", async () => {
    const f = setup();
    const a = note(f, "Deploy guide", "How to deploy a new version of sample-app.");
    embedNote(f, a, "Deploy guide", "How to deploy a new version of sample-app.");

    const result = await runSearch(requestCtx(f, SEMANTIC_SEARCH_ON), {
      scope: "notes",
      query: "deploy",
      limit: 10,
      max_tokens: 4000,
      include_proposed: true,
    });
    expect(result.results.map((r) => r.title)).toEqual(["Deploy guide"]);
  });
});

describe("runSearch: hybrid relevance (semantic_search on, model cached via the injected loader)", () => {
  it("surfaces a vector-only match with zero literal keyword overlap (the point of semantic search)", async () => {
    const f = setup();
    fakeModelCache(f.dataDir);
    const synonymMatch = note(f, "Release runbook", "Steps to deploy a new version.");
    embedNote(f, synonymMatch, "Release runbook", "Steps to deploy a new version.");
    const unrelated = note(f, "Unrelated", "This entry is about something else entirely.");
    embedNote(f, unrelated, "Unrelated", "This entry is about something else entirely.");

    // "ship" never appears in either entry; FTS alone would return zero results. With only two
    // candidates total, vec0's k=200 search returns both (there is nothing to exclude), ranked
    // by distance -- the assertion is ordering, not absence.
    const result = await runSearch(
      requestCtx(f, SEMANTIC_SEARCH_ON),
      { scope: "notes", query: "ship", limit: 10, max_tokens: 4000, include_proposed: true },
      fakeLoader,
    );
    const titles = result.results.map((r) => r.title);
    expect(titles).toContain("Release runbook");
    expect(titles.indexOf("Release runbook")).toBeLessThan(titles.indexOf("Unrelated"));
  });

  it("ranks an entry matching on both FTS and vector above one matching on only the vector side", async () => {
    const f = setup();
    fakeModelCache(f.dataDir);
    const both = note(f, "Deploy guide", "How to deploy a new version.");
    embedNote(f, both, "Deploy guide", "How to deploy a new version.");
    const vectorOnly = note(f, "Release runbook", "Steps to ship a release.");
    embedNote(f, vectorOnly, "Release runbook", "Steps to ship a release.");

    const result = await runSearch(
      requestCtx(f, SEMANTIC_SEARCH_ON),
      { scope: "notes", query: "deploy", limit: 10, max_tokens: 4000, include_proposed: true },
      fakeLoader,
    );
    const titles = result.results.map((r) => r.title);
    expect(titles.indexOf("Deploy guide")).toBeLessThan(titles.indexOf("Release runbook"));
  });

  it("degrades a single entry to FTS-only ranking when it has no vector yet, without affecting others", async () => {
    const f = setup();
    fakeModelCache(f.dataDir);
    const embedded = note(f, "Deploy guide", "deploy deploy deploy");
    embedNote(f, embedded, "Deploy guide", "deploy deploy deploy");
    note(f, "Deploy notes", "deploy"); // matches FTS, but was never embedded

    const result = await runSearch(
      requestCtx(f, SEMANTIC_SEARCH_ON),
      { scope: "notes", query: "deploy", limit: 10, max_tokens: 4000, include_proposed: true },
      fakeLoader,
    );
    expect(result.results.map((r) => r.title).sort()).toEqual(["Deploy guide", "Deploy notes"].sort());
  });

  it("never surfaces a vector-only match from a scope the query did not include", async () => {
    const f = setup();
    fakeModelCache(f.dataDir);
    f.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'other-scope', ?)").run(newId(), now());
    const otherScopeResult = writeEntry(writeCtx(f), {
      scope: "other-scope",
      kind: "note",
      title: "Other scope entry",
      body: "Steps to ship a release.",
      request_id: newId(),
    } as never);
    if ("held" in otherScopeResult) throw new Error("unexpected hold");
    embedNote(f, otherScopeResult, "Other scope entry", "Steps to ship a release.");

    const result = await runSearch(
      requestCtx(f, SEMANTIC_SEARCH_ON),
      { scope: "notes", query: "ship", limit: 10, max_tokens: 4000, include_proposed: true },
      fakeLoader,
    );
    expect(result.results.map((r) => r.title)).not.toContain("Other scope entry");
  });
});
