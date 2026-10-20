/**
 * sqlite-vec loading and the `embeddings_vec0` index (SPEC v8 11.2.1): a vec0 virtual table
 * joined back to the `embeddings` table by SQLite's implicit integer rowid, fixed to the pinned
 * model's dimension. Loaded unconditionally on every database open, independent of whether this
 * node computes its own embeddings, so a node can always store and query vectors that arrive
 * through sync (ADR 0004: "the hub must not need the model" to serve search over replicated
 * vectors; it does always need this extension, which has no model and no network dependency).
 *
 * Vectors are stored normalized (model.ts's `embed` always normalizes), so vec0's default L2
 * distance ranks identically to cosine distance; no separate metric configuration is needed.
 * A vector for a model other than EMBEDDING_DIM's is kept in `embeddings` (SPEC's own
 * never-overwritten-across-models rule) but not indexed here, since one vec0 table has one fixed
 * dimension; a second model with a different dimension would need a second vec0 table.
 */
import type Database from "better-sqlite3";
import { load } from "sqlite-vec";
import { EMBEDDING_DIM } from "./model.js";

export function loadVecExtension(db: Database.Database): void {
  load(db);
}

export const VEC0_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_vec0 USING vec0(embedding float[${EMBEDDING_DIM}]);`;

/** Keeps embeddings_vec0 in sync with one row of the embeddings table. No-op for a different model's dimension (not indexed in this slice). */
export function upsertVecIndex(db: Database.Database, entryId: string, modelId: string, dim: number, vector: readonly number[]): void {
  if (dim !== EMBEDDING_DIM) return;
  const row = db.prepare("SELECT rowid FROM embeddings WHERE entry_id = ? AND model_id = ?").get(entryId, modelId) as { rowid: number } | undefined;
  if (!row) return;
  const rowid = BigInt(row.rowid);
  db.prepare("DELETE FROM embeddings_vec0 WHERE rowid = ?").run(rowid);
  db.prepare("INSERT INTO embeddings_vec0 (rowid, embedding) VALUES (?, ?)").run(rowid, JSON.stringify(vector));
}

export function removeFromVecIndex(db: Database.Database, rowid: number): void {
  db.prepare("DELETE FROM embeddings_vec0 WHERE rowid = ?").run(BigInt(rowid));
}

export interface VecMatch {
  entryId: string;
  modelId: string;
  rank: number;
}

/** Nearest neighbors to `queryVector` by vec0's default (L2-on-normalized, equivalent to cosine) distance, best first. */
export function vecSearch(db: Database.Database, queryVector: readonly number[], limit: number): VecMatch[] {
  const rows = db
    .prepare(
      `SELECT e.entry_id AS entryId, e.model_id AS modelId
       FROM embeddings_vec0 v JOIN embeddings e ON e.rowid = v.rowid
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(JSON.stringify(queryVector), limit) as { entryId: string; modelId: string }[];
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}
