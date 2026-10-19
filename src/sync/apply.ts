import type Database from "better-sqlite3";
import { applyEvent as materializeEvent, type EventForMaterialize } from "../store/materialize.js";

/**
 * Apply one incoming replicated event (Spec v8 7.3), idempotently. This slice (M3 slice 2) only
 * implements the fast-forward and already-known rows of 7.3's table, plus relations (which never
 * conflict, Spec 7.4, so they always apply once their entry exists). The remaining two rows are
 * each their own later slice, not silently done wrong: a missing-parent or genuinely concurrent
 * content/status event, and every `claim`/`meta` event, are recorded in the event log (so the
 * log stays the source of truth and a future `ctxd rebuild` can retroactively materialize them
 * once the conflict policy and claims-across-nodes slices land) but are not materialized here.
 */
export interface WireEvent {
  eventId: string;
  originNode: string;
  originSeq: number;
  hlc: string;
  scopeId: string;
  entryId: string;
  op: string;
  part: "content" | "status" | "relations" | "claim" | "meta";
  parentRevs: string[];
  rev: string;
  clientId: string;
  sessionRef: string | null;
  requestId: string | null;
  requestHash: string | null;
  payload: Record<string, unknown>;
  prev: Record<string, unknown> | null;
}

export interface ApplyResult {
  /** "already-known" (dedup by event_id), "fast-forward" (materialized), or "deferred" (logged only). */
  outcome: "already-known" | "fast-forward" | "deferred";
}

const HEAD_REV_COLUMN: Partial<Record<WireEvent["part"], string>> = { content: "content_rev", status: "status_rev", relations: "relations_rev" };

function currentHeadRev(db: Database.Database, entryId: string, part: WireEvent["part"]): string | null {
  const column = HEAD_REV_COLUMN[part];
  if (!column) return null;
  const row = db.prepare(`SELECT ${column} AS rev FROM entries WHERE entry_id = ?`).get(entryId) as { rev: string } | undefined;
  return row?.rev ?? null;
}

/** Spec 7.3's fast-forward test, narrowed to the parts this slice materializes. */
function isFastForward(db: Database.Database, event: WireEvent): boolean {
  if (event.part === "claim" || event.part === "meta") return false;
  const head = currentHeadRev(db, event.entryId, event.part);
  if (event.part === "relations") return head !== null; // never conflicts (7.4); only needs its entry to exist
  if (head === null) return event.op === "create" && event.parentRevs.length === 0;
  return event.parentRevs.length === 1 && event.parentRevs[0] === head;
}

/** Apply one event idempotently (Spec 7.1's puller loop step 1; 7.3). */
export function applyEvent(db: Database.Database, event: WireEvent): ApplyResult {
  if (db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(event.eventId)) {
    return { outcome: "already-known" };
  }

  const fastForward = isFastForward(db, event);
  return db.transaction((): ApplyResult => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.eventId,
      event.originNode,
      event.originSeq,
      event.hlc,
      event.scopeId,
      event.entryId,
      event.op,
      event.part,
      JSON.stringify(event.parentRevs),
      event.rev,
      event.clientId,
      event.sessionRef,
      event.requestId,
      event.requestHash,
      JSON.stringify(event.payload),
      event.prev === null ? null : JSON.stringify(event.prev),
      new Date().toISOString(),
    );

    if (!fastForward) return { outcome: "deferred" };

    // Every EventForMaterialize field is already a same-named WireEvent field; only `part`'s
    // type needs narrowing (isFastForward already ruled out "claim" and "meta" to get here).
    materializeEvent(db, { ...event, part: event.part as EventForMaterialize["part"] });
    return { outcome: "fast-forward" };
  })();
}
