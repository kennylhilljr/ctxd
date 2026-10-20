import type Database from "better-sqlite3";
import { applyEvent as materializeEvent, applyReplicatedEvent as materializeReplicatedEvent, type EventForMaterialize } from "../store/materialize.js";
import { verifyEventSignature } from "../security/event-signatures.js";

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
  schemaVersion?: number;
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
  payloadHash?: string | null;
  prevHash?: string | null;
  signature?: string | null;
  publicKey?: string | null;
  payloadStripped?: boolean;
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

/**
 * The current epoch's own `claim_hlc`, used only to decide fast-forward vs concurrent (whether
 * this event's stated parent matches what's actually there right now, regardless of state): a
 * renewal, release or proven reclaim always names the live row's own claim_hlc as its parent
 * (store/claim.ts's `claimTask` and `releaseTask` reference whatever local row exists, active or
 * closed), never the task's all-time earliest (`store/materialize.ts`'s `currentClaimHeadFor`
 * returns that separate value, used only once a genuine conflict is confirmed, for the actual
 * earliest-wins comparison, Spec 7.4). Null only when this task has no lease row at all: a claim
 * made in total ignorance of this task's history (parentRevs=[] while a row already exists here)
 * is deliberately NOT treated as a fast-forward just because its own hlc happens to be later than
 * whatever closed the row last -- two nodes that never synced have no causal relationship between
 * their clocks, so "later" there proves nothing (found via this suite: a node's own late, never-
 * synced claim could otherwise outrace and overwrite an already-resolved, already-released
 * epoch). Such a claim falls through to "concurrent" below instead, resolved against the task's
 * true earliest claimant.
 */
function currentClaimHead(db: Database.Database, taskId: string): string | null {
  const row = db.prepare("SELECT claim_hlc FROM leases WHERE task_id = ?").get(taskId) as { claim_hlc: string } | undefined;
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
      return "missing-parent"; // no lease row for this task at all; see the release note below
    }
    if (event.parentRevs.length === 1 && event.parentRevs[0] === head) return "fast-forward";
    if (event.op === "claim") return "concurrent"; // a genuinely concurrent claim (Spec 7.4): the loser is known now, resolved against the task's earliest claimant
    // A release whose target doesn't match the row's current claim_hlc: this is NOT necessarily
    // stale. The row may currently hold a losing claim that just hasn't been evicted yet, because
    // the true winner (an earlier claim_hlc, Spec 7.4) hasn't arrived from its own origin -- per-
    // origin pull ordering (src/sync/pull.ts) guarantees a claim always arrives before its own
    // later release from the SAME origin, but a human client can release a claim it never held
    // (store/claim.ts's `releaseTask`), so a release's own origin can differ from the claim it
    // targets, and that ordering guarantee does not cover this case either. The same
    // never-seen-vs-superseded distinction content/status use below (`revEverRecorded`) applies
    // here too, just keyed on the claim's own hlc rather than a rev: if this node has never once
    // recorded a claim at that hlc, the target genuinely hasn't arrived yet and this defers
    // (`materialized = 0`, `retryPendingFor` below); if it has (even if long since superseded),
    // the mismatch is already fully explained and resolves now instead of sitting pending forever
    // (found via the N-node partition property suite: a release targeting a claim that hadn't
    // been evicted by its true winner yet was wrongly treated as already-resolved and silently
    // dropped, since `materialize.ts`'s own "stale" no-op never got to run again).
    const target = event.parentRevs.length === 1 ? event.parentRevs[0] : undefined;
    if (target !== undefined && claimHlcEverRecorded(db, event.entryId, target)) return "concurrent";
    return "missing-parent";
  }
  const column = HEAD_REV_COLUMN[event.part];
  const head = column && entry ? entry[column] : null;
  if (event.part === "relations") return head !== null ? "fast-forward" : "missing-parent"; // never conflicts (7.4); only needs its entry to exist
  if (head === null) return event.op === "create" && event.parentRevs.length === 0 ? "fast-forward" : "missing-parent";
  if (event.parentRevs.length === 1 && event.parentRevs[0] === head) return "fast-forward";
  // A mismatch doesn't by itself mean a genuine conflict: this event's own origin may simply not
  // be the one that produced `head`, so its stated parent can be a rev this node hasn't received
  // yet rather than one that's been superseded (per-origin pull batching, Spec 7.1, does not
  // guarantee cross-origin causal delivery order -- the same gap `retryPendingFor` already
  // retries claims and releases for). Only a parent this node has actually recorded for the
  // entry, under either part, is evidence of a real race; a parent it has never seen at all is
  // deferred and retried once it arrives (found via the N-node partition property suite: two
  // sequential, non-conflicting edits from different origins -- the second naming the first as
  // its parent -- arrived out of order on a third node, which applied the later edit against the
  // stale head, read that as a conflict, and flagged the entry `conflicted` for a chain that
  // never actually forked).
  const parent = event.parentRevs.length === 1 ? event.parentRevs[0] : undefined;
  if (parent !== undefined && !revEverRecorded(db, event.entryId, parent)) return "missing-parent";
  return "concurrent";
}

// Both checks require `materialized = 1`, not just a stored row: a parent event that is itself
// still deferred (stored with `materialized = 0`, e.g. a three-hop cross-origin chain where the
// middle link hasn't resolved yet either) has not actually "arrived" in any sense this decision
// can rely on. Without this, an event naming that still-pending parent would be judged a genuine
// conflict against the wrong head instead of deferred alongside it -- and once resolved that way
// it is permanently materialized, so it would never get a second chance once the real chain
// catches up (found via /code-review).
function revEverRecorded(db: Database.Database, entryId: string, rev: string): boolean {
  return db.prepare("SELECT 1 FROM events WHERE entry_id = ? AND rev = ? AND materialized = 1").get(entryId, rev) !== undefined;
}

/** `revEverRecorded`'s claim-part counterpart: a claim's own hlc, not a rev, is what a release's parentRevs names. */
function claimHlcEverRecorded(db: Database.Database, entryId: string, claimHlc: string): boolean {
  return (
    db.prepare("SELECT 1 FROM events WHERE entry_id = ? AND part = 'claim' AND op = 'claim' AND hlc = ? AND materialized = 1").get(entryId, claimHlc) !==
    undefined
  );
}

// Every EventForMaterialize field is already a same-named WireEvent field; only `part`'s type
// needs narrowing ("meta" was already ruled out by `decide` to get here). Only the
// confirmed-fast-forward branch for content/status/relations skips the conflict-checking entry
// point: `decide` already paid for the head query that branch would otherwise redo for nothing. A
// claim event always goes through it regardless of `decision`, fast-forward included, since even
// a non-conflicting replicated claim still needs the write-intent overlap check against other
// tasks that only that entry point runs (Spec 7.4); a local claim never reaches this function at
// all, so it is never run twice for the same claim.
function materializeByDecision(db: Database.Database, event: WireEvent, decision: Decision): void {
  const forMaterialize = { ...event, part: event.part as EventForMaterialize["part"] };
  if (decision === "concurrent" || event.part === "claim") {
    materializeReplicatedEvent(db, { ...forMaterialize, parentRevs: event.parentRevs });
  } else {
    materializeEvent(db, forMaterialize);
  }
}

/** A stored event row's columns in their raw, pre-parse form: shared by `retryPendingFor` below and `src/sync/pull.ts`'s own row mapping (which adds one column, `scope_replication`, that only it needs), so there is exactly one place that knows how to turn a DB row back into a `WireEvent`. */
export interface EventRow {
  event_id: string;
  schema_version: number;
  origin_node: string;
  origin_seq: number;
  hlc: string;
  scope_id: string;
  entry_id: string;
  op: string;
  part: WireEvent["part"];
  parent_revs: string;
  rev: string;
  client_id: string;
  session_ref: string | null;
  request_id: string | null;
  request_hash: string | null;
  payload: string;
  prev: string | null;
  payload_hash: string | null;
  prev_hash: string | null;
  signature: string | null;
  public_key: string | null;
  payload_stripped: number;
}

export function toWireEvent(row: EventRow): WireEvent {
  return {
    eventId: row.event_id,
    schemaVersion: row.schema_version,
    originNode: row.origin_node,
    originSeq: row.origin_seq,
    hlc: row.hlc,
    scopeId: row.scope_id,
    entryId: row.entry_id,
    op: row.op,
    part: row.part,
    parentRevs: JSON.parse(row.parent_revs) as string[],
    rev: row.rev,
    clientId: row.client_id,
    sessionRef: row.session_ref,
    requestId: row.request_id,
    requestHash: row.request_hash,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    prev: row.prev === null ? null : (JSON.parse(row.prev) as Record<string, unknown>),
    payloadHash: row.payload_hash,
    prevHash: row.prev_hash,
    signature: row.signature,
    publicKey: row.public_key,
    payloadStripped: row.payload_stripped === 1,
  };
}

/**
 * Re-decides every stored-but-not-yet-materialized ("missing-parent") event for this entry, now
 * that something about it just changed. Needed because `servePull` relays a page ordered by
 * (origin_node, origin_seq) (Spec 7.1): that preserves each origin's own causal order but not
 * causal order *across* origins, so a third node can receive, say, node B's update to an entry
 * node A created before it ever receives A's own create event. Scoped to one entry, since every
 * "missing-parent" case (a missing create, or a rev this event's parent names) is a fact about
 * that entry alone, never about another one. Loops to a fixpoint: materializing one deferred event
 * can itself unblock the next one chained after it.
 */
function retryPendingFor(db: Database.Database, entryId: string): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const rows = db
      .prepare(
        `SELECT event_id, schema_version, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev,
                client_id, session_ref, request_id, request_hash, payload, prev, payload_hash, prev_hash, signature, public_key, payload_stripped
         FROM events WHERE entry_id = ? AND materialized = 0 ORDER BY hlc`,
      )
      .all(entryId) as EventRow[];
    for (const row of rows) {
      const event = toWireEvent(row);
      const decision = decide(db, event);
      if (decision === "missing-parent") continue; // still blocked; a later retry pass may unblock it

      db.transaction(() => {
        if (decision === "purged") {
          // Same rewrite `applyEvent` would have done on first arrival (7.6.6 step 3), deferred
          // until now because the entry's purge itself hadn't landed yet either.
          db.prepare("UPDATE events SET payload = ?, prev = NULL, payload_stripped = 1, materialized = 1 WHERE event_id = ?").run(JSON.stringify({ purged: true }), row.event_id);
          return;
        }
        materializeByDecision(db, event, decision);
        db.prepare("UPDATE events SET materialized = 1 WHERE event_id = ?").run(row.event_id);
      })();
      progressed = true;
    }
  }
}

/** Apply one event idempotently (Spec 7.1's puller loop step 1; 7.3). */
export function applyEvent(db: Database.Database, event: WireEvent): ApplyResult {
  if (db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(event.eventId)) {
    return { outcome: "already-known" };
  }
  const decision = decide(db, event);
  const schemaVersion = event.schemaVersion ?? 1;
  if (event.payloadStripped && event.signature != null && decision !== "purged") throw new Error(`Untrusted purge stripping on event ${event.eventId}`);
  verifyEventSignature(db, { ...event, schemaVersion }, event.payloadStripped !== true);
  // 7.6.6 step 3: an event for an already-purged entry is stored with its content already gone,
  // the same shape a local purge rewrites every other stored event to (materialize.ts's purge
  // handler); never the raw payload this event arrived with.
  const payload = decision === "purged" ? { purged: true } : event.payload;
  const prev = decision === "purged" ? null : event.prev;
  const materialized = decision !== "missing-parent";

  const result = db.transaction((): ApplyResult => {
    db.prepare(
      `INSERT INTO events (event_id, schema_version, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, payload_hash, prev_hash, signature, public_key, payload_stripped, received_at, materialized)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.eventId,
      schemaVersion,
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
      event.payloadHash,
      event.prevHash,
      event.signature,
      event.publicKey,
      decision === "purged" ? 1 : 0,
      new Date().toISOString(),
      materialized ? 1 : 0,
    );

    if (decision === "purged") return { outcome: "purge-stripped" };
    if (decision === "missing-parent") return { outcome: "deferred" };

    materializeByDecision(db, event, decision);
    return { outcome: decision === "concurrent" ? "conflict-resolved" : "fast-forward" };
  })();

  // A deferred sibling for this same entry (stuck on this event's own prior absence) might now be
  // unblocked.
  if (materialized) retryPendingFor(db, event.entryId);

  return result;
}
