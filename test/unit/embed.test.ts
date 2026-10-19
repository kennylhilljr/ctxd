import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { EMBEDDING_DIM, MODEL_ID, MODEL_REVISION, isModelCached, modelCacheDir, type Embedder } from "../../src/embed/model.js";
import { upsertVecIndex, removeFromVecIndex, vecSearch } from "../../src/embed/vec.js";
import { embedPendingEntries, ensureEmbedClient, FULL_MODEL_ID } from "../../src/embed/compute.js";

/** Embeddings (SPEC v8 11.2.1): model caching, the sqlite-vec index, and the background embed job. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-embed-")), "ctxd.db");
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
  return { db, clock: new HlcClock(nodeId), nodeId, humanId };
}

function writeCtx(f: Fixture): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId };
}

function note(f: Fixture, title: string, body: string): { id: string } {
  const result = writeEntry(writeCtx(f), { scope: "notes", kind: "note", title, body, request_id: newId() } as never);
  if ("held" in result) throw new Error("unexpected hold");
  return result;
}

/** Places a dummy (non-model) weight file at exactly the path model.ts's isModelCached checks, so tests can exercise the "model is cached" branch without the real model. */
function fakeModelCache(dataDir: string): void {
  const file = join(modelCacheDir(dataDir), MODEL_ID, MODEL_REVISION, "onnx", "model_quantized.onnx");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "not a real model, just a presence marker");
}

/** A unit vector with a single 1 at `dim`, for deterministic, easy-to-reason-about distances. */
function unitVector(dim: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[dim] = 1;
  return v;
}

describe("model.ts: cache detection", () => {
  it("is not cached in a fresh data dir", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ctxd-embed-datadir-"));
    expect(isModelCached(dataDir)).toBe(false);
  });

  it("is cached once the weight file is present", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ctxd-embed-datadir-"));
    fakeModelCache(dataDir);
    expect(isModelCached(dataDir)).toBe(true);
  });
});

describe("vec.ts: the embeddings_vec0 index", () => {
  function insertEmbeddingRow(f: Fixture, entryId: string, vector: number[]): void {
    f.db
      .prepare("INSERT INTO embeddings (entry_id, model_id, dim, vector, rev, updated_hlc) VALUES (?, ?, ?, ?, '1-x', ?)")
      .run(entryId, FULL_MODEL_ID, EMBEDDING_DIM, JSON.stringify(vector), now());
  }

  it("upserts a vector and finds it as its own nearest neighbor", () => {
    const f = setup();
    const a = note(f, "A", "a");
    insertEmbeddingRow(f, a.id, unitVector(0));
    upsertVecIndex(f.db, a.id, FULL_MODEL_ID, EMBEDDING_DIM, unitVector(0));

    const matches = vecSearch(f.db, unitVector(0), 1);
    expect(matches).toEqual([{ entryId: a.id, modelId: FULL_MODEL_ID, rank: 1 }]);
  });

  it("ranks nearer vectors first", () => {
    const f = setup();
    const near = note(f, "Near", "n");
    const far = note(f, "Far", "f");
    insertEmbeddingRow(f, near.id, [0.9, 0.1, ...new Array(EMBEDDING_DIM - 2).fill(0)]);
    insertEmbeddingRow(f, far.id, unitVector(EMBEDDING_DIM - 1));
    upsertVecIndex(f.db, near.id, FULL_MODEL_ID, EMBEDDING_DIM, [0.9, 0.1, ...new Array(EMBEDDING_DIM - 2).fill(0)]);
    upsertVecIndex(f.db, far.id, FULL_MODEL_ID, EMBEDDING_DIM, unitVector(EMBEDDING_DIM - 1));

    const matches = vecSearch(f.db, unitVector(0), 2);
    expect(matches.map((m) => m.entryId)).toEqual([near.id, far.id]);
  });

  it("no-ops for a different model's dimension, since one vec0 table has one fixed dimension", () => {
    const f = setup();
    const a = note(f, "A", "a");
    insertEmbeddingRow(f, a.id, [1, 0]);
    upsertVecIndex(f.db, a.id, "other-model", 2, [1, 0]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec0").get()).toEqual({ n: 0 });
  });

  it("removeFromVecIndex deletes by rowid", () => {
    const f = setup();
    const a = note(f, "A", "a");
    insertEmbeddingRow(f, a.id, unitVector(0));
    upsertVecIndex(f.db, a.id, FULL_MODEL_ID, EMBEDDING_DIM, unitVector(0));
    const row = f.db.prepare("SELECT rowid FROM embeddings WHERE entry_id = ?").get(a.id) as { rowid: number };

    removeFromVecIndex(f.db, row.rowid);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec0").get()).toEqual({ n: 0 });
  });
});

describe("ensureEmbedClient", () => {
  it("is idempotent", () => {
    const f = setup();
    const a = ensureEmbedClient(f.db, f.nodeId);
    const b = ensureEmbedClient(f.db, f.nodeId);
    expect(a).toBe(b);
  });
});

describe("embedPendingEntries", () => {
  const fakeEmbedder: Embedder = { embed: async (text: string) => unitVector(text.length % EMBEDDING_DIM) };
  const fakeLoader = async (): Promise<Embedder | null> => fakeEmbedder;
  const noModelLoader = async (): Promise<Embedder | null> => null;

  function ctxFor(f: Fixture): WriteContext {
    return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: ensureEmbedClient(f.db, f.nodeId) };
  }

  it("is a no-op when the model is not cached (no loader available)", async () => {
    const f = setup();
    note(f, "A", "a");
    const result = await embedPendingEntries(ctxFor(f), "/does/not/matter", 20, noModelLoader);
    expect(result.embedded).toBe(0);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM embeddings").get()).toEqual({ n: 0 });
  });

  it("embeds every pending entry and materializes into embeddings and embeddings_vec0", async () => {
    const f = setup();
    const a = note(f, "A", "alpha");
    const b = note(f, "B", "beta");

    const result = await embedPendingEntries(ctxFor(f), "/does/not/matter", 20, fakeLoader);
    expect(result.embedded).toBe(2);

    const rows = f.db.prepare("SELECT entry_id, model_id, dim FROM embeddings ORDER BY entry_id").all() as { entry_id: string; model_id: string; dim: number }[];
    expect(rows.map((r) => r.entry_id).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((r) => r.model_id === FULL_MODEL_ID && r.dim === EMBEDDING_DIM)).toBe(true);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec0").get()).toEqual({ n: 2 });
  });

  it("writes an 'embedding' event carrying the same rev as the content it describes", async () => {
    const f = setup();
    const a = note(f, "A", "alpha");
    const contentRev = (f.db.prepare("SELECT content_rev FROM entries WHERE entry_id = ?").get(a.id) as { content_rev: string }).content_rev;

    await embedPendingEntries(ctxFor(f), "/does/not/matter", 20, fakeLoader);

    const event = f.db.prepare("SELECT op, part, rev FROM events WHERE entry_id = ? AND part = 'embedding'").get(a.id) as {
      op: string;
      part: string;
      rev: string;
    };
    expect(event).toEqual({ op: "update", part: "embedding", rev: contentRev });
  });

  it("is a no-op on a second run once every entry is embedded (nothing pending)", async () => {
    const f = setup();
    note(f, "A", "alpha");
    await embedPendingEntries(ctxFor(f), "/does/not/matter", 20, fakeLoader);
    const second = await embedPendingEntries(ctxFor(f), "/does/not/matter", 20, fakeLoader);
    expect(second.embedded).toBe(0);
  });

  it("re-embeds when content changes (stale rev no longer matches the stored embedding)", async () => {
    const f = setup();
    const a = note(f, "A", "alpha");
    await embedPendingEntries(ctxFor(f), "/does/not/matter", 20, fakeLoader);

    const contentRev = (f.db.prepare("SELECT content_rev FROM entries WHERE entry_id = ?").get(a.id) as { content_rev: string }).content_rev;
    writeEntry(writeCtx(f), {
      scope: "notes",
      kind: "note",
      id: a.id,
      title: "A",
      body: "alpha, revised",
      expected_rev: contentRev,
      request_id: newId(),
    } as never);

    const result = await embedPendingEntries(ctxFor(f), "/does/not/matter", 20, fakeLoader);
    expect(result.embedded).toBe(1);
  });
});
