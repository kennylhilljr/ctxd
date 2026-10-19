import type Database from "better-sqlite3";
import { applyEvent as materializeEvent, applyReplicatedEvent as materializeReplicatedEvent, type EventForMaterialize } from "../store/materialize.js";

/**
 * Apply one incoming replicated event (Spec v8 7.3), idempotently, covering every row of 7.3's
 * table except "missing parent" and `claim` events, which this slice still only logs
 * (claims-across-nodes is its own later slice): fast-forward, already-known, relations (never
 * conflict, 7.4), genuinely concurrent content/status events (via src/store/materialize.ts's
 * conflict policies, shared with `ctxd rebuild` so a replay from scratch reaches the same
 * materialized state this live apply does), purge events (always fast-forward: the purge handler
 * is an idempotent upsert, order- and retry-tolerant by construction, so there is no concurrent
 * case to resolve), and purge propagation's own step 3 (7.6.6): any event, of any kind, for an
 * entry already purged locally has its payload and prev stripped to `{"purged": true}` before
 * it is even stored, exactly like the events a local purge rewrites in place, so the content it
 * carries never lands and never needs rewriting again later.
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
   * materialized, the latter through a conflict policy); "purge-stripped" (stored with its
   * content already erased, Spec 7.6.6 step 3; never materialized); "deferred" (logged only: a
   * missing-parent content/status event, or any claim event).
   */
  outcome: "already-known" | "fast-forward" | "conflict-resolved" | "purge-stripped" | "deferred";
}

type Decision = "fast-forward" | "concurrent" | "missing-parent" | "deferred" | "purged";

const HEAD_REV_COLUMN: Partial<Record<WireEvent["part"], "content_rev" | "status_rev" | "relations_rev">> = {
  content: "content_rev",
  status: "status_rev",
  relations: "relations_rev",
};

interface EntryState {
  purged_at: string | null;
  content_rev: string;
  status_rev: string;
  relations_rev: string;
}

/** One row covers both `decide`'s checks (purged_at, and whichever *_rev column this event's part needs), instead of two separate lookups on the same entry. */
function loadEntryState(db: Database.Database, entryId: string): EntryState | undefined {
  return db.prepare("SELECT purged_at, content_rev, status_rev, relations_rev FROM entries WHERE entry_id = ?").get(entryId) as EntryState | undefined;
}

/** Spec 7.3's apply table, narrowed to the parts this slice knows how to resolve, plus 7.6.6's purge rows. */
function decide(db: Database.Database, event: WireEvent): Decision {
  const entry = loadEntryState(db, event.entryId);
  const isPurgeEvent = event.part === "meta" && event.op === "purge";
  // 7.6.6 step 3 strips any OTHER event for an already-purged entry; a second purge event (two
  // nodes independently purging the same entry while partitioned) is let through instead, so
  // materialize.ts's own HLC guard, not arrival order, decides whether it wins (7.3 convergence).
  if (entry?.purged_at != null && !isPurgeEvent) return "purged";
  if (event.part === "claim") return "deferred";
  if (event.part === "meta") return "fast-forward"; // the purge handler is an idempotent, HLC-guarded upsert; never a concurrent case this layer needs to resolve
  const column = HEAD_REV_COLUMN[event.part];
  const head = column && entry ? entry[column] : null;
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
  // 7.6.6 step 3: an event for an already-purged entry is stored with its content already gone,
  // the same shape a local purge rewrites every other stored event to (materialize.ts's purge
  // handler); never the raw payload this event arrived with.
  const payload = decision === "purged" ? { purged: true } : event.payload;
  const prev = decision === "purged" ? null : event.prev;

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
      JSON.stringify(payload),
      prev === null ? null : JSON.stringify(prev),
      new Date().toISOString(),
    );

    if (decision === "purged") return { outcome: "purge-stripped" };
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
