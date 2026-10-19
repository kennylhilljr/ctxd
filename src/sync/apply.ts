import type Database from "better-sqlite3";
import { applyEvent as materializeEvent, applyReplicatedEvent as materializeReplicatedEvent, type EventForMaterialize } from "../store/materialize.js";

/**
 * Apply one incoming replicated event (Spec v8 7.3), idempotently, covering every row of 7.3's
 * table except "missing parent" and `claim`/`meta` events, which this slice still only logs
 * (claims-across-nodes and purge propagation are their own later slices): fast-forward,
 * already-known, relations (never conflict, 7.4) and now genuinely concurrent content/status
 * events too, via src/store/materialize.ts's conflict policies (shared with `ctxd rebuild`, so
 * a replay from scratch reaches the same materialized state this live apply does).
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
  /**
   * "already-known" (dedup by event_id); "fast-forward" or "conflict-resolved" (both
   * materialized, the latter through a conflict policy); "deferred" (logged only: a
   * missing-parent content/status event, or any claim/meta event).
   */
  outcome: "already-known" | "fast-forward" | "conflict-resolved" | "deferred";
}

type Decision = "fast-forward" | "concurrent" | "missing-parent" | "deferred";

const HEAD_REV_COLUMN: Partial<Record<WireEvent["part"], string>> = { content: "content_rev", status: "status_rev", relations: "relations_rev" };

function currentHeadRev(db: Database.Database, entryId: string, part: WireEvent["part"]): string | null {
  const column = HEAD_REV_COLUMN[part];
  if (!column) return null;
  const row = db.prepare(`SELECT ${column} AS rev FROM entries WHERE entry_id = ?`).get(entryId) as { rev: string } | undefined;
  return row?.rev ?? null;
}

/** Spec 7.3's apply table, narrowed to the parts this slice knows how to resolve. */
function decide(db: Database.Database, event: WireEvent): Decision {
  if (event.part === "claim" || event.part === "meta") return "deferred";
  const head = currentHeadRev(db, event.entryId, event.part);
  if (event.part === "relations") return head !== null ? "fast-forward" : "missing-parent"; // never conflicts (7.4); only needs its entry to exist
  if (head === null) return event.op === "create" && event.parentRevs.length === 0 ? "fast-forward" : "missing-parent";
  if (event.parentRevs.length === 1 && event.parentRevs[0] === head) return "fast-forward";
  return "concurrent";
}

/** Apply one event idempotently (Spec 7.1's puller loop step 1; 7.3). */
export function applyEvent(db: Database.Database, event: WireEvent): ApplyResult {
  if (db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(event.eventId)) {
    return { outcome: "already-known" };
  }

  const decision = decide(db, event);
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

    if (decision === "deferred" || decision === "missing-parent") return { outcome: "deferred" };

    // Every EventForMaterialize field is already a same-named WireEvent field; only `part`'s
    // type needs narrowing ("claim"/"meta" were already ruled out by `decide` to get here). Only
    // the confirmed-fast-forward branch skips the conflict-checking entry point: `decide` already
    // paid for the head-rev query that branch would otherwise redo for nothing. The concurrent
    // branch still pays its own head-rev query inside materializeReplicatedEvent, since it needs
    // the matching events-table row (not just the rev string) to resolve the conflict.
    const forMaterialize = { ...event, part: event.part as EventForMaterialize["part"] };
    if (decision === "concurrent") {
      materializeReplicatedEvent(db, { ...forMaterialize, parentRevs: event.parentRevs });
    } else {
      materializeEvent(db, forMaterialize);
    }
    return { outcome: decision === "concurrent" ? "conflict-resolved" : "fast-forward" };
  })();
}
