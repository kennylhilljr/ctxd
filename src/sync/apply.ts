import type Database from "better-sqlite3";
import { applyEvent as materializeEvent, applyReplicatedEvent as materializeReplicatedEvent, type EventForMaterialize } from "../store/materialize.js";

/**
 * Apply one incoming replicated event (Spec v8 7.3), idempotently: fast-forward, already-known,
 * relations (never conflict, 7.4), genuinely concurrent content/status/claim events (via
 * src/store/materialize.ts's conflict policies, shared with `ctxd rebuild` so a replay from
 * scratch reaches the same materialized state this live apply does), purge events (always
 * fast-forward: the purge handler is an idempotent, HLC-guarded upsert, order- and
 * retry-tolerant by construction), and purge propagation's own step 3 (7.6.6): any non-purge
 * event for an entry already purged locally has its payload and prev stripped to
 * `{"purged": true}` before it is even stored. Only a genuinely missing-parent content/status/
 * claim event, or a release for a claim already superseded, is held back or no-op'd.
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
   * missing-parent content/status/claim event). "conflict-resolved" also covers a stale release
   * (one whose claim was already superseded): routed through the same conflict-checking path as
   * a genuine race, even though materialize.ts's own handler finds nothing to resolve there.
   */
  outcome: "already-known" | "fast-forward" | "conflict-resolved" | "purge-stripped" | "deferred";
}

type Decision = "fast-forward" | "concurrent" | "missing-parent" | "purged";

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

/** The active lease's `claim_hlc` for a task (the claim part's "head", Spec 7.3), or null when no claim is active there. */
function currentClaimHead(db: Database.Database, taskId: string): string | null {
  const row = db.prepare("SELECT claim_hlc FROM leases WHERE task_id = ? AND state = 'active'").get(taskId) as { claim_hlc: string } | undefined;
  return row?.claim_hlc ?? null;
}

/** Spec 7.3's apply table, narrowed to the parts this slice knows how to resolve, plus 7.6.6's purge rows. */
function decide(db: Database.Database, event: WireEvent): Decision {
  const entry = loadEntryState(db, event.entryId);
  const isPurgeEvent = event.part === "meta" && event.op === "purge";
  // 7.6.6 step 3 strips any OTHER event for an already-purged entry; a second purge event (two
  // nodes independently purging the same entry while partitioned) is let through instead, so
  // materialize.ts's own HLC guard, not arrival order, decides whether it wins (7.3 convergence).
  if (entry?.purged_at != null && !isPurgeEvent) return "purged";
  if (event.part === "meta") return "fast-forward"; // purge (an idempotent, HLC-guarded upsert) and acl (M3 slice 6, Spec v8 4) are both plain upserts with no concurrent case this layer needs to resolve
  if (event.part === "claim") {
    // suspend/resume (quarantine, 7.6.2) carry no real parentRevs and never conflict, same as
    // every claim-part op did before this slice; only claim/release consult the head below.
    if (event.op !== "claim" && event.op !== "release") return "fast-forward";
    const head = currentClaimHead(db, event.entryId);
    if (head === null) {
      if (event.op === "claim") return event.parentRevs.length === 0 ? "fast-forward" : "missing-parent"; // a fresh claim, or one referencing a prior claim not yet synced
      // A release with no active lease to match: per-origin pull ordering (src/sync/pull.ts)
      // guarantees a claim always arrives before its own later release from the same origin, so
      // this is never "the claim hasn't synced yet" -- it is always a release whose target claim
      // already left 'active' (a duplicate release, or one superseded by a take-over or an even
      // later release). Routed to "concurrent" so materialize.ts's own no-op handles it, instead
      // of sitting "deferred" forever for a parent that was never going to arrive.
      return "concurrent";
    }
    if (event.parentRevs.length === 1 && event.parentRevs[0] === head) return "fast-forward";
    return "concurrent"; // a genuinely concurrent claim (Spec 7.4), or a release whose target claim was already superseded
  }
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
    if (decision === "missing-parent") return { outcome: "deferred" };

    // Every EventForMaterialize field is already a same-named WireEvent field; only `part`'s
    // type needs narrowing ("meta" was already ruled out by `decide` to get here). Only the
    // confirmed-fast-forward branch for content/status/relations skips the conflict-checking
    // entry point: `decide` already paid for the head query that branch would otherwise redo for
    // nothing. A claim event always goes through it regardless of `decision`, fast-forward
    // included, since even a non-conflicting replicated claim still needs the write-intent
    // overlap check against other tasks that only that entry point runs (Spec 7.4); a local
    // claim never reaches this function at all, so it is never run twice for the same claim.
    const forMaterialize = { ...event, part: event.part as EventForMaterialize["part"] };
    if (decision === "concurrent" || event.part === "claim") {
      materializeReplicatedEvent(db, { ...forMaterialize, parentRevs: event.parentRevs });
    } else {
      materializeEvent(db, forMaterialize);
    }
    return { outcome: decision === "concurrent" ? "conflict-resolved" : "fast-forward" };
  })();
}
