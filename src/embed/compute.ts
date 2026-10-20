/**
 * Background embedding (SPEC v8 11.2.1): gated by `semantic_search.compute` (off by default).
 * Threading async model inference through the fully synchronous writeEntry path would force
 * every one of its dozens of call sites to become async for one feature's benefit, so this is
 * a fast-follow catch-up job instead, the same shape as the weekly digest's and sync's own
 * server.ts periodic ticks: it scans for entries whose embedding is missing or stale and embeds
 * them, appending an `embedding` event that carries the same `rev` as the content it describes.
 *
 * Written directly (a raw event insert plus `applyEvent`, bypassing the normal access-decision
 * path), exactly like `purgeEntry`: an embedding event is derived metadata inheriting the
 * entry's own already-approved access, not an independent user-initiated write (SPEC 11.2.1:
 * "An embedding event carries the same scope and vendor policy as the entry it describes").
 *
 * Embeds any entry missing a current vector, not only ones this node itself wrote: two nodes
 * computing the same model_id for the same text produce the same vector (SPEC's own "never
 * conflicts" guarantee), so catching up entries that arrived through sync is strictly additive.
 */
import type Database from "better-sqlite3";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { canonicalJson } from "../store/idempotency.js";
import { applyEvent } from "../store/materialize.js";
import type { WriteContext } from "../store/write.js";
import { EMBEDDING_DIM, MODEL_DTYPE, MODEL_ID, loadEmbedder } from "./model.js";
import { signStoredEvent } from "../security/event-signatures.js";

export const FULL_MODEL_ID = `${MODEL_ID}@${MODEL_DTYPE}`;

/** Finds or creates the synthetic "embed" client (vendor `local`) attributed on embedding events. */
export function ensureEmbedClient(db: Database.Database, nodeId: string): string {
  const existing = db.prepare("SELECT client_id FROM clients WHERE name = 'embed'").get() as { client_id: string } | undefined;
  if (existing) return existing.client_id;
  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'embed', 'local', ?, ?, ?)").run(
    clientId,
    nodeId,
    newId(),
    nowIso(),
  );
  return clientId;
}

interface PendingRow {
  entryId: string;
  scopeId: string;
  title: string;
  body: string;
  contentRev: string;
}

function pendingEntries(db: Database.Database, limit: number): PendingRow[] {
  return db
    .prepare(
      `SELECT e.entry_id AS entryId, e.scope_id AS scopeId, e.title, e.body, e.content_rev AS contentRev
       FROM entries e LEFT JOIN embeddings emb ON emb.entry_id = e.entry_id AND emb.model_id = ?
       WHERE e.purged_at IS NULL AND e.status != 'deleted' AND (emb.rev IS NULL OR emb.rev != e.content_rev)
       LIMIT ?`,
    )
    .all(FULL_MODEL_ID, limit) as PendingRow[];
}

function appendEmbeddingEvent(ctx: WriteContext, row: PendingRow, vector: readonly number[]): void {
  const { db } = ctx;
  const eventId = newId();
  const hlc = ctx.clock.tick();
  const nextOriginSeq = (
    db.prepare("SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM events WHERE origin_node = ?").get(ctx.nodeId) as { next: number }
  ).next;
  const payload = { model_id: FULL_MODEL_ID, dim: EMBEDDING_DIM, vector: [...vector] };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'update', 'embedding', '[]', ?, ?, NULL, NULL, NULL, ?, NULL, ?)`,
    ).run(eventId, ctx.nodeId, nextOriginSeq, hlc, row.scopeId, row.entryId, row.contentRev, ctx.clientId, canonicalJson(payload), nowIso());
    signStoredEvent(db, eventId, ctx.flags);
    applyEvent(db, {
      eventId,
      scopeId: row.scopeId,
      entryId: row.entryId,
      op: "update",
      part: "embedding",
      rev: row.contentRev,
      clientId: ctx.clientId,
      hlc,
      payload,
      prev: null,
    });
  })();
}

export interface EmbedTickResult {
  embedded: number;
}

/** Embeds up to `limit` pending entries. A no-op (embedded: 0) if the model is not cached yet. `loadEmbedderFn` is injectable so tests can exercise this without the real model. */
export async function embedPendingEntries(
  ctx: WriteContext,
  dataDir: string,
  limit = 20,
  loadEmbedderFn: typeof loadEmbedder = loadEmbedder,
): Promise<EmbedTickResult> {
  const embedder = await loadEmbedderFn(dataDir);
  if (!embedder) return { embedded: 0 };

  const rows = pendingEntries(ctx.db, limit);
  for (const row of rows) {
    const vector = await embedder.embed(`${row.title}\n\n${row.body}`);
    appendEmbeddingEvent(ctx, row, vector);
  }
  return { embedded: rows.length };
}
