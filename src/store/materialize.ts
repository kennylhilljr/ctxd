import type Database from "better-sqlite3";
import { revVersion } from "../core/ids.js";
import { compareHlc, decodeHlc } from "../core/hlc.js";
import { LWW_CONTENT_KINDS, type Kind } from "../core/kinds.js";
import { persistOverlaps, scanOverlappingLeases } from "../claims/overlap.js";
import { loadClient } from "./snapshot.js";
import { removeFromVecIndex, upsertVecIndex } from "../embed/vec.js";

/**
 * Turns one already-appended event into its effect on `entries` and `relations` (SPEC v6
 * section 6, step 7; conflict policies, Spec v8 7.4). Shared by the live write path
 * (store/write.ts), `ctxd rebuild` (store/rebuild.ts) and sync's puller (src/sync/apply.ts), so
 * all three can never materialize an event differently.
 */

export interface EventForMaterialize {
  eventId: string;
  scopeId: string;
  entryId: string;
  op: string;
  part: "content" | "status" | "relations" | "claim" | "meta" | "embedding";
  rev: string;
  clientId: string;
  hlc: string;
  payload: Record<string, unknown>;
  prev: Record<string, unknown> | null;
}

/** A replicated event (Spec 7.3): its own stated parent revision(s), so this is checked for a genuinely concurrent arrival (Spec 7.4) rather than trusted as fast-forward. */
export type ReplicatedEvent = EventForMaterialize & { parentRevs: string[] };

/** The current head revision for a part that can conflict, or undefined for a part with none (relations/meta never reach a conflict check; claim has its own head, `currentClaimHeadFor`, since leases aren't rev-versioned the same way). */
function currentRevFor(db: Database.Database, entryId: string, part: "content" | "status"): string | undefined {
  const column = part === "content" ? "content_rev" : "status_rev";
  const row = db.prepare(`SELECT ${column} AS rev FROM entries WHERE entry_id = ?`).get(entryId) as { rev: string } | undefined;
  return row?.rev;
}

interface ClaimHead {
  /** The current epoch's own claim_hlc: what a renewal or release's parentRevs must match to be a fast-forward. */
  claimHlc: string;
  /** This task's smallest claim_hlc ever, across every epoch: what a genuine conflict is decided against (Spec 7.4). */
  earliestClaimHlc: string;
  /** The row's own `state`/`last_activity_hlc`, needed by the release branch's own-HLC guard (`isStaleByHlc`); fetched here too so that branch doesn't re-query the same row a second time. */
  state: string;
  lastActivityHlc: string;
}

/**
 * The claim state an incoming claim/release must be checked against (Spec 7.3's "head" for the
 * claim part), or undefined only when this task has no lease row at all. Unlike content/status,
 * a claim part's head is checked regardless of the lease's current `state`: `store/claim.ts`'s
 * `claimTask` and `releaseTask` always set a new event's parentRevs to whatever local row exists
 * (active or closed), never empty just because the row happens to be closed, so a renewal,
 * release or proven reclaim's parentRevs always names the live row's own claim_hlc as its parent
 * and fast-forwards through the match check below regardless of state. A claim made in total
 * ignorance of this task's history (parentRevs=[] while a row already exists here) can never
 * match that way, so it always falls through to a genuine conflict, resolved against
 * `earliestClaimHlc` -- deliberately not against whichever HLC it happens to carry relative to a
 * clock it never synced with (found via the N-node partition property suite: a node's own fresh,
 * never-synced claim could otherwise fast-forward in and overwrite an already-resolved,
 * already-released epoch purely because its claim's wall-clock HLC happened to sort later).
 *
 * Returns two different hlcs rather than one, because they answer two different questions.
 * `claimHlc` is the live epoch's own claim_hlc, which is what a renewal or release's own
 * parentRevs names as its parent (fast-forward vs concurrent). `earliestClaimHlc` is this task's
 * smallest claim_hlc ever, across every epoch, not just the current one: a straggler from a
 * long-closed-and-reclaimed epoch must still lose to the task's true earliest claimant once a
 * genuine conflict is confirmed, not to whichever claim happens to be active or most recently
 * closed right now (Spec 7.4's "earliest claim_hlc wins" is not undone by what later happens to
 * the winning side's own state, e.g. a release and reclaim the winner makes before ever learning
 * of the losing side's claim). It never resets, only ever shrinks, deliberately: resetting it at
 * the start of each new epoch was tried and reverted, because which epoch a given node considers
 * "current" when a late, cross-origin claim finally arrives depends on delivery order (per-origin
 * pull batching, Spec 7.1, does not guarantee cross-origin causal order), so two nodes could reset
 * at different points and end up comparing the same late claim against two different values. A
 * value every node agrees on regardless of delivery order has to be monotonic.
 */
function currentClaimHeadFor(db: Database.Database, taskId: string): ClaimHead | undefined {
  const row = db.prepare("SELECT claim_hlc, earliest_claim_hlc, state, last_activity_hlc FROM leases WHERE task_id = ?").get(taskId) as
    | { claim_hlc: string; earliest_claim_hlc: string; state: string; last_activity_hlc: string }
    | undefined;
  if (!row) return undefined;
  return { claimHlc: row.claim_hlc, earliestClaimHlc: row.earliest_claim_hlc, state: row.state, lastActivityHlc: row.last_activity_hlc };
}

/** The shared stale-by-HLC idiom (Spec 7.6.6's purge guard, and the claim-release guard below): true once something has already recorded a result at `referenceHlc` that this `incomingHlc` cannot improve on. */
function isStaleByHlc(incomingHlc: string, referenceHlc: string): boolean {
  return compareHlc(incomingHlc, referenceHlc) <= 0;
}

/** The event that currently holds `rev` for this entry, whatever part it was recorded under (ranks share a rev value with their creating event: Spec v6 4, status_rev/content_rev/relations_rev all start equal to the create event's own rev). */
function eventHoldingRev(db: Database.Database, entryId: string, rev: string): { event_id: string; client_id: string; hlc: string } | undefined {
  return db.prepare("SELECT event_id, client_id, hlc FROM events WHERE entry_id = ? AND rev = ?").get(entryId, rev) as
    | { event_id: string; client_id: string; hlc: string }
    | undefined;
}

function isHumanClient(db: Database.Database, clientId: string): boolean {
  return loadClient(db, clientId)?.vendor === "human";
}

/** `INSERT OR IGNORE`: the same conflict can be detected more than once via different relay paths (or, for `revert-conflict`, a revert retried after a crash), with no new information the second time. */
export function recordSibling(db: Database.Database, entryId: string, part: string, rev: string, eventId: string, reason: string): void {
  db.prepare("INSERT OR IGNORE INTO entry_siblings (entry_id, part, rev, event_id, reason) VALUES (?, ?, ?, ?, ?)").run(entryId, part, rev, eventId, reason);
}

/** The shared shape of all three conflict policies: record the loser as a sibling, and if the incoming event won, run `applyWinner` to materialize it. */
function resolveConflict(
  db: Database.Database,
  part: "content" | "status" | "claim",
  entryId: string,
  reason: string,
  incomingWins: boolean,
  currentRev: string,
  local: { event_id: string },
  incoming: { eventId: string; rev: string },
  applyWinner: () => void,
): void {
  if (incomingWins) {
    recordSibling(db, entryId, part, currentRev, local.event_id, reason);
    applyWinner();
  } else {
    recordSibling(db, entryId, part, incoming.rev, incoming.eventId, reason);
  }
}

function mergeAndUpdateContent(
  db: Database.Database,
  entryId: string,
  current: { title: string; summary: string; body: string; tags: string },
  payload: Record<string, unknown>,
  rev: string,
  clientId: string,
  hlc: string,
  skipFts: boolean,
): void {
  const p = payload as { title?: string; body?: string; summary?: string; tags?: string[] };
  const merged = {
    title: p.title ?? current.title,
    summary: p.summary ?? current.summary,
    body: p.body ?? current.body,
    tags: p.tags !== undefined ? JSON.stringify(p.tags) : current.tags,
  };
  db.prepare(
    "UPDATE entries SET title = ?, summary = ?, body = ?, tags = ?, content_rev = ?, content_version = ?, updated_by = ?, updated_hlc = ? WHERE entry_id = ?",
  ).run(merged.title, merged.summary, merged.body, merged.tags, rev, revVersion(rev), clientId, hlc, entryId);
  if (!skipFts) syncFtsRow(db, entryId, current);
}

/** Spec 7.4: "Status (all kinds)": a human-client event wins; otherwise the later HLC wins. The loser is kept as a sibling. */
function applyStatusConflict(db: Database.Database, e: ReplicatedEvent, currentStatusRev: string): void {
  const local = eventHoldingRev(db, e.entryId, currentStatusRev);
  if (!local) return; // defensive: the rev this entry claims to hold has no recorded event; nothing safe to compare against
  const incomingHuman = isHumanClient(db, e.clientId);
  const localHuman = isHumanClient(db, local.client_id);
  const incomingWins = incomingHuman !== localHuman ? incomingHuman : compareHlc(e.hlc, local.hlc) > 0;

  resolveConflict(db, "status", e.entryId, "lww", incomingWins, currentStatusRev, local, e, () => {
    const p = e.payload as { status: string };
    const prevStatus = (e.prev as { status?: string } | null)?.status ?? null;
    db.prepare("UPDATE entries SET status = ?, status_before = ?, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
      p.status,
      prevStatus,
      e.rev,
      e.hlc,
      e.entryId,
    );
  });
}

/**
 * Spec 7.4: "Content of status, brief" is last-writer-wins (reason `lww`, surfaced in
 * `ctxd review` as auto-resolved); every other mutable kind moves the entry to `conflicted`
 * (reason `conflict`), with both revisions kept and the head at the higher HLC so reads still
 * work. Clearing a `conflicted` status, once a human reconciles the content by hand, reuses the
 * existing `ctxd review --approve` path (src/store/review.ts): that was already built for
 * `proposed`/`conflicted` before sync existed, and does not need its own mechanism here.
 */
function applyContentConflict(db: Database.Database, e: ReplicatedEvent, currentContentRev: string, skipFts: boolean): void {
  const entry = db.prepare("SELECT kind, title, summary, body, tags FROM entries WHERE entry_id = ?").get(e.entryId) as
    | { kind: Kind; title: string; summary: string; body: string; tags: string }
    | undefined;
  const local = eventHoldingRev(db, e.entryId, currentContentRev);
  if (!entry || !local) return;

  const incomingWins = compareHlc(e.hlc, local.hlc) > 0;
  const lww = LWW_CONTENT_KINDS.has(entry.kind);
  const reason = lww ? "lww" : "conflict";

  resolveConflict(db, "content", e.entryId, reason, incomingWins, currentContentRev, local, e, () => {
    mergeAndUpdateContent(db, e.entryId, entry, e.payload, e.rev, e.clientId, e.hlc, skipFts);
    // "Edit... also close[s] open flags with that action as the resolution" (SPEC 7.6.1) applies
    // here exactly as it does to an ordinary content update: the winning side's content did just
    // change, whether or not this particular change also moved status to 'conflicted' below.
    closeOpenFlags(db, e.entryId, "edit");
  });

  if (!lww) {
    db.prepare("UPDATE entries SET status = 'conflicted' WHERE entry_id = ? AND status NOT IN ('conflicted', 'deleted', 'archived', 'superseded')").run(e.entryId);
  }
}

/** The claim UPSERT (Spec 7.5.3): a fresh claim, a renewal, a take-over, or (via `applyClaimConflict`) the winning side of a concurrent-claim race. Shared so there is exactly one place that writes `leases` for a `claim` op. */
function upsertLease(db: Database.Database, e: EventForMaterialize): void {
  const p = e.payload as {
    holder: string;
    paths: string[] | null;
    ttl_minutes: number;
    session_ref: string | null;
    base_head: string | null;
    taken_over_from: string | null;
    tentative?: boolean;
  };
  const expiresAt = new Date(decodeHlc(e.hlc).physical + p.ttl_minutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO leases (task_id, scope_id, holder, state, paths, claim_event, claim_hlc, earliest_claim_hlc, session_ref, base_head, expires_at, last_activity_hlc, tentative, taken_over_by)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE SET
       scope_id = excluded.scope_id, holder = excluded.holder, state = 'active', paths = excluded.paths,
       claim_event = excluded.claim_event, claim_hlc = excluded.claim_hlc,
       earliest_claim_hlc = MIN(leases.earliest_claim_hlc, excluded.earliest_claim_hlc),
       session_ref = excluded.session_ref,
       base_head = excluded.base_head, expires_at = excluded.expires_at, last_activity_hlc = excluded.last_activity_hlc,
       tentative = excluded.tentative, released_at = NULL, changed_files = NULL, drift = NULL, lost_by = NULL,
       taken_over_by = excluded.taken_over_by`,
  ).run(
    e.entryId,
    e.scopeId,
    p.holder,
    p.paths !== null ? JSON.stringify(p.paths) : null,
    e.eventId,
    e.hlc,
    e.hlc,
    p.session_ref,
    p.base_head,
    expiresAt,
    e.hlc,
    p.tentative ? 1 : 0,
    p.taken_over_from,
  );
}

/**
 * Spec 7.4: "Concurrent claims on one task: the earliest claim_hlc wins." Only reached via
 * `applyReplicatedEvent` once its parentRevs-vs-current-head check has already confirmed a
 * mismatch: claim.ts's own CLAIM_HELD/CLAIM_STALE checks never let a local claim write a parent
 * that mismatches the live lease, so this is always a genuinely concurrent claim made offline,
 * unaware of the other. Earliest wins on every node regardless of which claim it applies first
 * here (the convergence property, 7.3); whichever claim is not earliest never becomes active,
 * and is recorded as a lost sibling (entry_siblings, reason "lost") instead, so it can be
 * surfaced to its own holder later without the single leases row needing to represent both
 * outcomes.
 */
function applyClaimConflict(db: Database.Database, e: ReplicatedEvent, earliestClaimHlc: string): void {
  const local = db.prepare("SELECT claim_event, claim_hlc FROM leases WHERE task_id = ?").get(e.entryId) as
    | { claim_event: string; claim_hlc: string }
    | undefined;
  if (!local) return; // defensive: `currentClaimHeadFor` just reported this HLC, so its row should exist
  // Decided against `earliestClaimHlc` (the smallest claim_hlc this task has ever contended, Spec
  // 7.4), not the current epoch's own `claim_hlc`: a straggler from a closed-and-reclaimed epoch
  // must still lose to the task's true earliest claimant, not to whatever the current epoch
  // happens to be. The *recorded* loser, when the incoming side wins, is still the current
  // epoch's own claim (`local.claim_hlc`/`claim_event`): that is the actual row being evicted.
  const incomingWins = compareHlc(e.hlc, earliestClaimHlc) <= 0;
  resolveConflict(db, "claim", e.entryId, "lost", incomingWins, local.claim_hlc, { event_id: local.claim_event }, { eventId: e.eventId, rev: e.hlc }, () => {
    upsertLease(db, e);
    recordClaimOverlaps(db, e);
  });
}

/**
 * Spec 7.4's other concurrent-claim case: write intent overlapping an already-active claim on a
 * DIFFERENT task. Only reached from `applyReplicatedEvent` (sync, or `ctxd rebuild` replaying a
 * historical sync-originated claim): a local claim already ran this same check synchronously
 * (claim.ts, via the same `scanOverlappingLeases`) and returned it straight to the caller, so a
 * local claim's own overlaps are never persisted here.
 */
function recordClaimOverlaps(db: Database.Database, e: EventForMaterialize): void {
  const p = e.payload as { paths: string[] | null };
  const { overlaps } = scanOverlappingLeases(db, e.scopeId, e.entryId, p.paths ?? undefined);
  if (overlaps.length === 0) return;
  const policy = (db.prepare("SELECT intent_policy FROM scopes WHERE scope_id = ?").get(e.scopeId) as { intent_policy: string }).intent_policy;
  persistOverlaps(db, e.entryId, e.hlc, policy, overlaps, "sync");
}

interface CreatePayload {
  kind: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  status: string;
  significance?: string | null;
  skill_name?: string | null;
  confirmed_by_user?: boolean;
  review_after?: string | null;
  supersedes?: string | null;
}

export interface ApplyEventOptions {
  /** Skip the incremental per-event FTS sync. `ctxd rebuild` sets this and does one bulk FTS5 rebuild instead. */
  skipFts?: boolean;
}

/**
 * Apply a trusted event: the caller already read the current head and is building the next
 * revision from it (the live write path, store/write.ts; `ctxd review`'s resolve), so this is
 * fast-forward by construction and never runs a conflict check. A caller that cannot make that
 * guarantee (`ctxd rebuild`, sync's puller) calls `applyReplicatedEvent` instead: the choice of
 * entry point, not an optional field on a shared type, is what decides whether a conflict check
 * runs, so a future caller cannot silently skip it by forgetting to pass something.
 */
export function applyEvent(db: Database.Database, e: EventForMaterialize, opts: ApplyEventOptions = {}): void {
  if (isPurgedNoOp(e)) return;
  applyEventCore(db, e, opts.skipFts ?? false);
}

/** Apply a possibly-concurrent event (Spec 7.3, 7.4): checks `parentRevs` against the current head for content/status/claim parts and resolves a genuine conflict before falling through to the same core every other event goes through. */
export function applyReplicatedEvent(db: Database.Database, e: ReplicatedEvent, opts: ApplyEventOptions = {}): void {
  if (isPurgedNoOp(e)) return;
  const skipFts = opts.skipFts ?? false;

  if (e.part === "content" && e.op === "update") {
    const current = currentRevFor(db, e.entryId, "content");
    if (current !== undefined && !(e.parentRevs.length === 1 && e.parentRevs[0] === current)) {
      applyContentConflict(db, e, current, skipFts);
      return;
    }
  } else if (e.part === "status" && e.op === "status") {
    const current = currentRevFor(db, e.entryId, "status");
    if (current !== undefined && !(e.parentRevs.length === 1 && e.parentRevs[0] === current)) {
      applyStatusConflict(db, e, current);
      return;
    }
  } else if (e.part === "claim" && e.op === "claim") {
    const current = currentClaimHeadFor(db, e.entryId);
    if (current !== undefined && !(e.parentRevs.length === 1 && e.parentRevs[0] === current.claimHlc)) {
      applyClaimConflict(db, e, current.earliestClaimHlc);
      return;
    }
    // A legitimate continuation (renewal, take-over, or a brand-new claim with no prior lease),
    // not a race: materialize normally, then check it against OTHER active tasks' write intent.
    // That overlap check only runs here (sync, or a rebuild replaying a historical sync-originated
    // claim), never for a local claim, which already ran the identical check synchronously in
    // claim.ts and returned it straight to the caller.
    applyEventCore(db, e, skipFts);
    recordClaimOverlaps(db, e);
    return;
  } else if (e.part === "claim" && e.op === "release") {
    const current = currentClaimHeadFor(db, e.entryId);
    if (current === undefined || !(e.parentRevs.length === 1 && e.parentRevs[0] === current.claimHlc)) {
      // Stale: this release targets a claim already superseded by a later claim or take-over
      // (or none is active at all). `decide` only routes a release here once it has already
      // confirmed the mismatch, so there is nothing left to do but leave the current lease alone.
      return;
    }
    if (current.state !== "active" && isStaleByHlc(e.hlc, current.lastActivityHlc)) {
      // A second, racing release of the same still-active epoch (Spec 7.4): two different holders
      // can each release the same claim while partitioned (its own holder, and a human override
      // elsewhere), both naming the same claim_hlc as their parent and so both passing the match
      // above regardless of delivery order. Only the later-hlc release's own payload
      // (released_at/changed_files/drift) may win, deterministically on every node -- the same rule
      // the purge handler's own-HLC guard already applies below. Found via the N-node partition
      // property suite: without this, whichever release a node happened to apply LAST simply
      // overwrote the fields, so two nodes that received the same pair of releases in different
      // orders disagreed about which one's details survived.
      return;
    }
  }

  applyEventCore(db, e, skipFts);
}

// Purge rewrites every OTHER stored event for the entry to {"purged": true} (SPEC 7.6.6 step 2);
// replaying one of those neutered events (e.g. a rebuild after a purge) must not try to
// materialize a create/update/etc with no real payload. The purge event's own payload is never
// rewritten, so this never short-circuits the purge handler in applyEventCore below.
// Fixed in SPEC-v7 (was an M1 gap): a rebuild after a purge used to leave the entry absent from
// `entries`, since the create event that would normally insert the row is one of the neutered
// ones. The purge handler now UPSERTs using scope_id/kind/slug carried in its own event payload,
// so it reconstructs the stub row whether or not the create event ran first.
function isPurgedNoOp(e: EventForMaterialize): boolean {
  return (e.payload as { purged?: boolean }).purged === true;
}

function applyEventCore(db: Database.Database, e: EventForMaterialize, skipFts: boolean): void {
  if (e.part === "content" && e.op === "create") {
    const p = e.payload as unknown as CreatePayload;
    db.prepare(
      `INSERT INTO entries (
         entry_id, scope_id, kind, slug, significance, skill_name, title, summary, body, tags,
         content_rev, content_version, status, status_rev, relations_rev, review_after,
         confirmed_by_user, supersedes, created_by, updated_by, created_hlc, updated_hlc
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.entryId,
      e.scopeId,
      p.kind,
      p.slug,
      p.significance ?? null,
      p.skill_name ?? null,
      p.title,
      p.summary,
      p.body,
      JSON.stringify(p.tags),
      e.rev,
      p.status,
      e.rev,
      e.rev,
      p.review_after ?? null,
      p.confirmed_by_user ? 1 : 0,
      p.supersedes ?? null,
      e.clientId,
      e.clientId,
      e.hlc,
      e.hlc,
    );
    if (!skipFts) syncFtsRow(db, e.entryId, null);
    return;
  }

  if (e.part === "content" && e.op === "update") {
    const current = db.prepare("SELECT title, summary, body, tags FROM entries WHERE entry_id = ?").get(e.entryId) as
      | { title: string; summary: string; body: string; tags: string }
      | undefined;
    if (!current) throw new Error(`materialize: update for missing entry ${e.entryId}`);
    mergeAndUpdateContent(db, e.entryId, current, e.payload, e.rev, e.clientId, e.hlc, skipFts);
    // "Edit... also close[s] open flags with that action as the resolution" (SPEC 7.6.1).
    closeOpenFlags(db, e.entryId, "edit");
    return;
  }

  if (e.part === "status" && e.op === "status") {
    const p = e.payload as { status: string };
    const prevStatus = (e.prev as { status?: string } | null)?.status ?? null;
    db.prepare("UPDATE entries SET status = ?, status_before = ?, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
      p.status,
      prevStatus,
      e.rev,
      e.hlc,
      e.entryId,
    );
    // "...supersede, archive and purge also close open flags with that action as the resolution" (SPEC 7.6.1).
    if (p.status === "superseded" || p.status === "archived") closeOpenFlags(db, e.entryId, p.status === "superseded" ? "supersede" : "archive");
    return;
  }

  if (e.part === "relations" && e.op === "relate") {
    const p = e.payload as { type: string; ref: string; note?: string | null; link_id: string };
    db.prepare("INSERT INTO relations (link_id, entry_id, type, target, note, added_event) VALUES (?, ?, ?, ?, ?, ?)").run(
      p.link_id,
      e.entryId,
      p.type,
      p.ref,
      p.note ?? null,
      e.eventId,
    );
    db.prepare("UPDATE entries SET relations_rev = ? WHERE entry_id = ?").run(e.rev, e.entryId);
    return;
  }

  if (e.part === "status" && e.op === "flag") {
    const p = e.payload as { flag_id: string; problem: string; reason: string };
    db.prepare("INSERT INTO flags (flag_id, entry_id, problem, reason, flagged_by, flagged_hlc, resolved) VALUES (?, ?, ?, ?, ?, ?, NULL)").run(
      p.flag_id,
      e.entryId,
      p.problem,
      p.reason,
      e.clientId,
      e.hlc,
    );
    // "An entry already flagged gets an additional flag row; its status is unchanged" (SPEC 7.6.1):
    // only the first open flag moves status to 'flagged', preserving the original status_before.
    const current = db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(e.entryId) as { status: string };
    if (current.status !== "flagged") {
      db.prepare("UPDATE entries SET status = 'flagged', status_before = ?, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
        current.status,
        e.rev,
        e.hlc,
        e.entryId,
      );
    }
    return;
  }

  if (e.part === "claim" && e.op === "claim") {
    upsertLease(db, e);
    return;
  }

  if (e.part === "claim" && e.op === "release") {
    const p = e.payload as { changed_files: string[] | null; drift: string[] | null };
    db.prepare(
      "UPDATE leases SET state = 'released', released_at = ?, changed_files = ?, drift = ?, last_activity_hlc = ? WHERE task_id = ?",
    ).run(
      new Date(decodeHlc(e.hlc).physical).toISOString(),
      p.changed_files !== null ? JSON.stringify(p.changed_files) : null,
      p.drift !== null ? JSON.stringify(p.drift) : null,
      e.hlc,
      e.entryId,
    );
    return;
  }

  if (e.part === "status" && e.op === "unflag") {
    const current = db.prepare("SELECT status_before FROM entries WHERE entry_id = ?").get(e.entryId) as { status_before: string | null };
    // status_before should always be set once an entry is flagged; the fallback only guards
    // against replaying a malformed or hand-crafted event, never a real unflag of a live entry.
    const restored = current.status_before ?? "active";
    db.prepare("UPDATE entries SET status = ?, status_before = NULL, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
      restored,
      e.rev,
      e.hlc,
      e.entryId,
    );
    closeOpenFlags(db, e.entryId, "unflagged");
    return;
  }

  if (e.part === "status" && e.op === "resolve") {
    // `ctxd review --approve` (SPEC 7.4's "a resolve event... clears it", for both a proposed
    // entry awaiting review and, once M3's sync lands, a conflicted one): always lands on
    // 'active'. Unlike unflag, there is no status_before to restore from.
    db.prepare("UPDATE entries SET status = 'active', status_before = NULL, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(e.rev, e.hlc, e.entryId);
    return;
  }

  if (e.part === "status" && e.op === "quarantine") {
    // Mirrors the flag branch's status_before/restore pattern (SPEC 7.6.2 step 3): record the
    // status being left behind so release (unquarantine) or revert can put it back.
    const current = db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(e.entryId) as { status: string };
    db.prepare("UPDATE entries SET status = 'quarantined', status_before = ?, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
      current.status,
      e.rev,
      e.hlc,
      e.entryId,
    );
    return;
  }

  if (e.part === "status" && e.op === "unquarantine") {
    // SPEC 7.6.4: "unquarantine events restore each member's status_before."
    const current = db.prepare("SELECT status_before FROM entries WHERE entry_id = ?").get(e.entryId) as { status_before: string | null };
    const restored = current.status_before ?? "active";
    db.prepare("UPDATE entries SET status = ?, status_before = NULL, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
      restored,
      e.rev,
      e.hlc,
      e.entryId,
    );
    return;
  }

  if (e.part === "content" && e.op === "delete") {
    // SPEC 7.6.3's revert-tombstone for an entry created inside a quarantine window. There is no
    // separate "content erased" representation distinct from purge's purged_at (7.6.6), and the
    // status enum already has a 'deleted' value for this, so a delete event is materialized the
    // same way as quarantine/unquarantine: record status_before, flip the status column.
    const current = db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(e.entryId) as { status: string };
    db.prepare("UPDATE entries SET status = 'deleted', status_before = ?, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
      current.status,
      e.rev,
      e.hlc,
      e.entryId,
    );
    return;
  }

  if (e.part === "relations" && e.op === "unrelate") {
    // Soft delete, matching the schema's own convention (relations_entry's index is already
    // `WHERE removed_event IS NULL`): set removed_event rather than deleting the row, so history
    // (and a future sync peer) can still see the link existed.
    const p = e.payload as { link_id: string };
    db.prepare("UPDATE relations SET removed_event = ? WHERE link_id = ? AND removed_event IS NULL").run(e.eventId, p.link_id);
    db.prepare("UPDATE entries SET relations_rev = ? WHERE entry_id = ?").run(e.rev, e.entryId);
    return;
  }

  if (e.part === "claim" && e.op === "suspend") {
    // SPEC 7.6.2 step 4: suspended claims no longer block other agents, and overlaps ignore them
    // (see claim.ts's otherActive query). Modeled as its own claim-part event, not a direct table
    // write, so a rebuild reconstructs suspension the same way it reconstructs the lease itself.
    db.prepare("UPDATE leases SET suspended_at = ? WHERE task_id = ?").run(new Date(decodeHlc(e.hlc).physical).toISOString(), e.entryId);
    return;
  }

  if (e.part === "claim" && e.op === "resume") {
    db.prepare("UPDATE leases SET suspended_at = NULL WHERE task_id = ?").run(e.entryId);
    return;
  }

  if (e.part === "meta" && e.op === "purge") {
    const payload = e.payload as { fingerprint: string; scope_id: string; kind: string; slug: string };
    const before = db.prepare("SELECT rowid, title, body, tags, purged_at, updated_hlc FROM entries WHERE entry_id = ?").get(e.entryId) as
      | { rowid: number; title: string; body: string; tags: string; purged_at: string | null; updated_hlc: string }
      | undefined;
    // Two nodes can each independently purge the same entry while partitioned (their own,
    // possibly differently-fingerprinted, unsynced content). Sync's apply.ts lets every purge
    // event through rather than treating the second one as a stripped late arrival, so that
    // whichever purge carries the later HLC always wins here, on every node, regardless of which
    // one that node happens to receive first (the convergence property, 7.3): an already-purged
    // entry's row is only touched by a purge event whose HLC is at least as new as the one that
    // set it. An older-HLC purge event is a no-op for the row; its own stored event payload still
    // keeps its fingerprint (untouched by the rewrite below), but it does not become the entry's
    // `purge_fingerprint`, so reinsertion-blocking only covers whichever fingerprint's HLC won.
    const alreadyPurged = before?.purged_at != null;
    if (alreadyPurged && isStaleByHlc(e.hlc, before.updated_hlc)) return;
    // UPSERT, not a plain UPDATE (SPEC v7 7.6.6): a rebuild replays the create event neutered to
    // {"purged": true} (the guard at the top of this function), so the row may not exist yet when
    // this purge event itself is replayed. scope_id/kind/slug come from the purge event's own
    // payload (recorded at purge time in store/purge.ts); the other NOT NULL columns get inert
    // placeholders derived from the purge event (content_rev/status_rev/relations_rev from its
    // rev, created/updated by/hlc from its client and hlc, status 'archived'), since a purged
    // entry's status and revisions are never meaningfully read again (get.ts and fts.ts both key
    // off purged_at, never status, to detect a purged entry).
    // The ON CONFLICT branch sets every one of those placeholder columns too, not just the
    // content fields: convergence (SPEC 7.3) requires a purged entry to materialize identically
    // whether this event finds the row already live (the normal write path) or reconstructs it
    // from nothing (a rebuild), so a purge must fully normalize the row either way rather than
    // leave live-only fields (status, content_rev, created_hlc, ...) at their pre-purge values.
    db.prepare(
      `INSERT INTO entries (
         entry_id, scope_id, kind, slug, title, summary, body, tags,
         content_rev, content_version, status, status_rev, relations_rev,
         purged_at, purge_fingerprint, created_by, updated_by, created_hlc, updated_hlc
       ) VALUES (?, ?, ?, ?, '[purged]', '', '', '[]', ?, 1, 'archived', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entry_id) DO UPDATE SET
         title = '[purged]', summary = '', body = '', tags = '[]',
         content_rev = excluded.content_rev, content_version = excluded.content_version,
         status = excluded.status, status_rev = excluded.status_rev, relations_rev = excluded.relations_rev,
         purged_at = excluded.purged_at, purge_fingerprint = excluded.purge_fingerprint,
         created_by = excluded.created_by, updated_by = excluded.updated_by,
         created_hlc = excluded.created_hlc, updated_hlc = excluded.updated_hlc`,
    ).run(
      e.entryId,
      payload.scope_id,
      payload.kind,
      payload.slug,
      e.rev,
      e.rev,
      e.rev,
      e.hlc,
      payload.fingerprint,
      e.clientId,
      e.clientId,
      e.hlc,
      e.hlc,
    );
    // The one-time erasure (FTS row, relations, open flags, every other stored event) already
    // ran when the entry was first purged; a later-HLC purge event that wins here (above) only
    // updates the row's own columns. Re-running the FTS 'delete' command against content that is
    // no longer indexed (this entry's real title/body were removed by that first purge) corrupts
    // the index rather than no-op-ing, so this whole block is step 1 only, done exactly once.
    if (!alreadyPurged) {
      // entries_fts is an external-content table: a plain DELETE does nothing (and can corrupt
      // the index); it needs the 'delete' command with the row's prior values, same as syncFtsRow.
      if (!skipFts && before) {
        db.prepare("INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', ?, ?, ?, ?)").run(
          before.rowid,
          before.title,
          before.body,
          ftsTags(before.tags),
        );
      }
      db.prepare("DELETE FROM relations WHERE entry_id = ?").run(e.entryId);
      db.prepare("UPDATE relations SET target = '[purged]' WHERE target LIKE ?").run(`%/${e.entryId}`);
      closeOpenFlags(db, e.entryId, "purge");
      // "Erase history": every stored event for this entry is rewritten in place (the only
      // operation that rewrites events, ADR-0002's own carve-out) -- but not this purge event
      // itself, whose own payload is exactly what records the fingerprint that blocks reinsertion.
      db.prepare("UPDATE events SET payload = '{\"purged\":true}', prev = NULL WHERE entry_id = ? AND event_id != ?").run(e.entryId, e.eventId);
      // Embeddings (SPEC 11.2.1): deleted on every node, same as the entry's other content. A
      // plain DELETE on an already-empty set is a harmless no-op, unlike the FTS 'delete' command
      // above, but grouped here anyway as part of the same one-time erasure.
      const embeddingRows = db.prepare("SELECT rowid FROM embeddings WHERE entry_id = ?").all(e.entryId) as { rowid: number }[];
      for (const er of embeddingRows) removeFromVecIndex(db, er.rowid);
      db.prepare("DELETE FROM embeddings WHERE entry_id = ?").run(e.entryId);
    }
    return;
  }

  if (e.part === "meta" && e.op === "acl") {
    applyAclEvent(db, e);
    return;
  }

  // Embeddings (SPEC 11.2.1): current content only, like FTS -- a later vector for the same
  // (entry, model) replaces the earlier one; a different model_id is kept alongside, never
  // overwritten, so a model change is additive rather than a silent mix of vector spaces.
  if (e.part === "embedding" && e.op === "update") {
    const p = e.payload as unknown as { model_id: string; dim: number; vector: number[] };
    db.prepare(
      `INSERT INTO embeddings (entry_id, model_id, dim, vector, rev, updated_hlc) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (entry_id, model_id) DO UPDATE SET dim = excluded.dim, vector = excluded.vector, rev = excluded.rev, updated_hlc = excluded.updated_hlc`,
    ).run(e.entryId, p.model_id, p.dim, JSON.stringify(p.vector), e.rev, e.hlc);
    upsertVecIndex(db, e.entryId, p.model_id, p.dim, p.vector);
    return;
  }

  throw new Error(`materialize: no handler yet for op=${e.op} part=${e.part} (lands with its own M1 slice)`);
}

/**
 * Spec v8 4: "Access metadata... changes only through acl events... in the reserved _system
 * scope." `e.entryId` is the deterministic id of the thing being changed (a scope or pool's own
 * id for most actions, a client's id for `client_grant`), not a knowledge entry; these events
 * never touch `entries`. Scope and pool creation are plain, order-independent upserts: their ids
 * are already collision-free across nodes (`core/ids.ts`'s `deterministicId`), so whichever
 * node's create a given node sees first just wins, nothing to guard. Every other action mutates
 * an existing row (a grant, a membership, a review policy), where two nodes making genuinely
 * *conflicting* changes while partitioned (one grants a level the other revokes, for the same
 * pool and scope) need the same HLC-guarded-upsert treatment purge and claims already get,
 * applied here via `aclGuardPasses`/`acl_cursors` (found missing during `/simplify`, M3 slice 6).
 */
type AclPayload =
  | { action: "scope_create"; name: string; kind: string; replication: string; vendor_policy: string }
  | { action: "scope_review_policy_set"; review_policy: unknown[] }
  | { action: "pool_create"; name: string; description: string }
  | { action: "pool_grant"; scope_id: string; level: string }
  | { action: "pool_revoke"; scope_id: string }
  | { action: "pool_add_member"; principal: string }
  | { action: "pool_remove_member"; principal: string }
  | { action: "client_grant"; scope_id: string; level: string; expires_at: string; granted_by: string };

/**
 * HLC guard for a mutable acl target (Spec v8 4, found during `/simplify`): `decide` fast-forwards
 * every acl event unconditionally (Spec 7.3's generic apply table has no notion of "the pool_grants
 * row for this pool+scope"), so without this, a grant and a revoke of the same target applied out
 * of causal order would converge on whichever one a given node happens to apply last, not on
 * whichever is actually later -- silently un-revoking access a later revoke already took away.
 * `target` names the specific row being touched (never just the coarser pool/client id `e.entryId`
 * carries, which is shared by every grant and every membership change for that pool), so unrelated
 * writes never spuriously contend. Returns false (skip) when a prior acl event already touched
 * this exact target with an equal-or-later HLC.
 */
function aclGuardPasses(db: Database.Database, target: string, hlc: string): boolean {
  const row = db.prepare("SELECT updated_hlc FROM acl_cursors WHERE target = ?").get(target) as { updated_hlc: string } | undefined;
  // Strictly earlier loses; a tie accepts (found during /code-review). An encoded HLC tie can
  // only happen between two events from the *same* origin node (the node id is part of the
  // string, so two different nodes never produce an identical one) -- either a genuine replay of
  // the same event (idempotent either way: every action here is itself an idempotent upsert or
  // delete) or two rapid, separate CLI invocations on this node whose HlcClock each started fresh
  // at the same millisecond. In both cases this node's own transaction order is the real causal
  // order regardless of what the tied clock values say, so rejecting a tie would silently drop a
  // second, distinct local action instead of applying it.
  if (row && compareHlc(hlc, row.updated_hlc) < 0) return false;
  db.prepare("INSERT INTO acl_cursors (target, updated_hlc) VALUES (?, ?) ON CONFLICT (target) DO UPDATE SET updated_hlc = excluded.updated_hlc").run(
    target,
    hlc,
  );
  return true;
}

function applyAclEvent(db: Database.Database, e: EventForMaterialize): void {
  const p = e.payload as unknown as AclPayload;
  const createdAt = new Date(decodeHlc(e.hlc).physical).toISOString();
  switch (p.action) {
    case "scope_create":
      // Deterministic, name-derived scope_id (core/ids.ts) means two nodes creating the same
      // name while partitioned already agree on the id, so there is nothing to guard about
      // *which* create wins; the declared fields (replication, vendor_policy) still need one,
      // found during /code-review: two nodes creating "the same" scope with different flags
      // would otherwise each keep its own values forever (the first local apply always wins
      // locally, via ON CONFLICT DO NOTHING, before the other side's event ever arrives).
      if (!aclGuardPasses(db, `scope:${e.entryId}`, e.hlc)) return;
      db.prepare(
        `INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, replication = excluded.replication, vendor_policy = excluded.vendor_policy`,
      ).run(e.entryId, p.name, p.kind, p.replication, p.vendor_policy, createdAt);
      return;
    case "scope_review_policy_set":
      if (!aclGuardPasses(db, `scope_review_policy:${e.entryId}`, e.hlc)) return;
      db.prepare("UPDATE scopes SET review_policy = ? WHERE scope_id = ?").run(JSON.stringify(p.review_policy), e.entryId);
      return;
    case "pool_create":
      if (!aclGuardPasses(db, `pool:${e.entryId}`, e.hlc)) return;
      db.prepare(
        `INSERT INTO pools (pool_id, name, description, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (pool_id) DO UPDATE SET name = excluded.name, description = excluded.description`,
      ).run(e.entryId, p.name, p.description, createdAt);
      return;
    case "pool_grant":
      if (!aclGuardPasses(db, `pool_grant:${e.entryId}:${p.scope_id}`, e.hlc)) return;
      db.prepare(
        "INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, ?) ON CONFLICT (pool_id, scope_id) DO UPDATE SET level = excluded.level",
      ).run(e.entryId, p.scope_id, p.level);
      return;
    case "pool_revoke":
      if (!aclGuardPasses(db, `pool_grant:${e.entryId}:${p.scope_id}`, e.hlc)) return;
      db.prepare("DELETE FROM pool_grants WHERE pool_id = ? AND scope_id = ?").run(e.entryId, p.scope_id);
      return;
    case "pool_add_member":
      if (!aclGuardPasses(db, `pool_member:${e.entryId}:${p.principal}`, e.hlc)) return;
      db.prepare("INSERT OR IGNORE INTO pool_members (pool_id, principal) VALUES (?, ?)").run(e.entryId, p.principal);
      return;
    case "pool_remove_member":
      if (!aclGuardPasses(db, `pool_member:${e.entryId}:${p.principal}`, e.hlc)) return;
      db.prepare("DELETE FROM pool_members WHERE pool_id = ? AND principal = ?").run(e.entryId, p.principal);
      return;
    case "client_grant":
      if (!aclGuardPasses(db, `client_grant:${e.entryId}:${p.scope_id}`, e.hlc)) return;
      db.prepare(
        `INSERT INTO client_grants (client_id, scope_id, level, expires_at, granted_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (client_id, scope_id) DO UPDATE SET level = excluded.level, expires_at = excluded.expires_at, granted_by = excluded.granted_by`,
      ).run(e.entryId, p.scope_id, p.level, p.expires_at, p.granted_by);
      return;
    default:
      throw new Error(`materialize: unknown acl action ${JSON.stringify((e.payload as { action?: unknown }).action)}`);
  }
}

/** Close every open flag on an entry with the given resolution (SPEC v6 section 7.6.1). */
function closeOpenFlags(db: Database.Database, entryId: string, resolution: string): void {
  db.prepare("UPDATE flags SET resolved = ? WHERE entry_id = ? AND resolved IS NULL").run(resolution, entryId);
}

/** Sync the FTS5 external-content row for an entry after it changes (SPEC v6 section 4). */
export function syncFtsRow(
  db: Database.Database,
  entryId: string,
  before: { title: string; body: string; tags: string } | null,
): void {
  const row = db.prepare("SELECT rowid, title, body, tags FROM entries WHERE entry_id = ?").get(entryId) as
    | { rowid: number; title: string; body: string; tags: string }
    | undefined;
  if (!row) return;
  if (before) {
    db.prepare("INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', ?, ?, ?, ?)").run(
      row.rowid,
      before.title,
      before.body,
      ftsTags(before.tags),
    );
  }
  db.prepare("INSERT INTO entries_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)").run(
    row.rowid,
    row.title,
    row.body,
    ftsTags(row.tags),
  );
}

/** Tags are stored as a JSON array; FTS indexes them as plain space-joined words. */
export function ftsTags(tagsJson: string): string {
  return (JSON.parse(tagsJson) as string[]).join(" ");
}
