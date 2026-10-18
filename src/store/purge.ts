import type Database from "better-sqlite3";
import { makeRev, newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { CtxdError } from "../core/errors.js";
import { parseRef } from "../model/refs.js";
import { canonicalJson, requestHash } from "./idempotency.js";
import { applyEvent } from "./materialize.js";
import { loadClient } from "./snapshot.js";
import type { WriteContext } from "./write.js";

/**
 * `ctxd purge <ref> --reason <text>` (SPEC v6 section 7.6.6): human only, confirmed. Erases
 * content in place, deletes its FTS row, detaches its relations, and rewrites every OTHER
 * stored event for the entry to {"purged": true} -- the one operation that rewrites events
 * (ADR-0002's own carve-out). The fingerprint blocks re-inserting the same content later
 * (store/write.ts checks it on create).
 *
 * M1 scope notes (flagged for SPEC-v7, not silently cut):
 * - "Strip late arrivals" (step 3) is a sync-time concern; there's no replication in M1.
 * - "--rewrite-backups" (step 5) needs the M4 encrypted backup system.
 * - A rebuild after a purge leaves the entry absent from `entries` rather than present with
 *   placeholder content, since the create event that would normally insert the row is one of
 *   the neutered ones (see materialize.ts's top-of-applyEvent comment).
 */

export interface PurgePreview {
  ref: string;
  kind: string;
  title: string;
  scope: string;
}

export function previewPurge(db: Database.Database, ref: string): PurgePreview {
  const { row, scopeName } = resolveForPurge(db, ref);
  return { ref, kind: row.kind, title: row.title, scope: scopeName };
}

export interface PurgeResult {
  ref: string;
  purged_at: string;
  fingerprint: string;
}

function resolveForPurge(
  db: Database.Database,
  ref: string,
): { row: { entry_id: string; scope_id: string; kind: string; title: string; body: string }; scopeName: string } {
  const parsed = parseRef(ref);
  const id = parsed ? parsed.id : ref;
  const row = db.prepare("SELECT entry_id, scope_id, kind, title, body FROM entries WHERE entry_id = ?").get(id) as
    | { entry_id: string; scope_id: string; kind: string; title: string; body: string }
    | undefined;
  if (!row) throw new CtxdError("NOT_FOUND", `Entry not found: ${ref}`, {}, "ref");
  const scope = db.prepare("SELECT name FROM scopes WHERE scope_id = ?").get(row.scope_id) as { name: string } | undefined;
  return { row, scopeName: scope?.name ?? row.scope_id };
}

export function purgeEntry(ctx: WriteContext, ref: string, reason: string): PurgeResult {
  const { db } = ctx;
  const client = loadClient(db, ctx.clientId);
  if (!client) throw new CtxdError("UNAUTHORIZED", "Unknown or revoked client");
  if (client.vendor !== "human") throw new CtxdError("NOT_ALLOWED", "purge is human only");

  const { row } = resolveForPurge(db, ref);
  const fingerprint = requestHash({ title: row.title, body: row.body });

  const eventId = newId();
  const hlc = ctx.clock.tick();
  const nextOriginSeq = (
    db.prepare("SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM events WHERE origin_node = ?").get(ctx.nodeId) as { next: number }
  ).next;
  const payload = { fingerprint, reason };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'purge', 'meta', '[]', ?, ?, NULL, NULL, NULL, ?, NULL, ?)`,
    ).run(eventId, ctx.nodeId, nextOriginSeq, hlc, row.scope_id, row.entry_id, makeRev(1, eventId), ctx.clientId, canonicalJson(payload), nowIso());
    applyEvent(db, {
      eventId,
      scopeId: row.scope_id,
      entryId: row.entry_id,
      op: "purge",
      part: "meta",
      rev: makeRev(1, eventId),
      clientId: ctx.clientId,
      hlc,
      payload,
      prev: null,
    });
  })();

  return { ref, purged_at: hlc, fingerprint };
}
