import type Database from "better-sqlite3";
import { makeRev, newId, revVersion } from "../core/ids.js";
import { decodeHlc } from "../core/hlc.js";
import { nowIso } from "../core/time.js";
import { CtxdError } from "../core/errors.js";
import { parseRef } from "../model/refs.js";
import { timeWindow } from "../journal/time.js";
import { canonicalJson } from "./idempotency.js";
import { applyEvent, recordSibling } from "./materialize.js";
import { loadClient, loadScopeByName } from "./snapshot.js";
import type { WriteContext } from "./write.js";
import { signStoredEvent } from "../security/event-signatures.js";
import { allocateOriginSeq } from "./origin-seq.js";

/**
 * Quarantine, revert and release (SPEC v6 section 7.6.2-7.6.4): human-only cleanup for a
 * misbehaving source. Every effect -- hiding an entry, suspending a claim, restoring content,
 * removing a link, resuming or releasing a claim -- is its own appended event, never a direct
 * table write (ADR 0002: "never mutate materialized state without an event"). `batches` and
 * `batch_members` are the one piece of bookkeeping that is *not* reconstructed by `ctxd rebuild`
 * (there is no "open a batch" event in the log, mirroring how `leases` already carries fields
 * with no event of their own, e.g. `tentative`); the entry/relations/claim effects of quarantine,
 * revert and release are fully event-sourced and replay identically.
 */

export interface QuarantineSelector {
  client?: string;
  session?: string;
  since?: string;
  until?: string;
  scope?: string;
}

export interface QuarantineResult {
  batch_id: string;
  entries: number;
  suspended_claims: number;
}

export interface BatchActionResult {
  batch_id: string;
  state: string;
  members: { entry_id: string; outcome: string | null }[];
}

export interface BatchShowResult {
  batch_id: string;
  kind: string;
  selector: Record<string, unknown>;
  state: string;
  created_by: string;
  created_hlc: string;
  members: { entry_id: string; first_event: string; created_in_batch: boolean; outcome: string | null }[];
}

interface BatchRow {
  batch_id: string;
  kind: string;
  selector: string;
  state: string;
  created_by: string;
  created_hlc: string;
}

interface MemberRow {
  batch_id: string;
  entry_id: string;
  first_event: string;
  created_in_batch: number;
  outcome: string | null;
}

export interface SelEvent {
  event_id: string;
  scope_id: string;
  entry_id: string;
  hlc: string;
  client_id: string;
  session_ref: string | null;
  part: "content" | "status" | "relations";
  op: string;
  rev: string;
  prev: string | null;
}

interface HygieneEventSpec {
  scopeId: string;
  entryId: string;
  op: string;
  part: "content" | "status" | "relations" | "claim" | "meta";
  rev: string;
  parentRevs?: string[];
  payload: Record<string, unknown>;
  prev?: Record<string, unknown> | null;
  eventId: string;
  hlc: string;
}

/** Exported for src/store/rollback.ts (SPEC 7.6.5), which selects and reverts in one step rather than two separate human actions, and reuses this same human-only check at batch-creation time. */
export function requireHuman(db: Database.Database, clientId: string, what: string): void {
  const client = loadClient(db, clientId);
  if (!client) throw new CtxdError("UNAUTHORIZED", "Unknown or revoked client");
  if (client.vendor !== "human") throw new CtxdError("NOT_ALLOWED", `${what} is human only`);
}

function entryIdFromRef(ref: string): string {
  const parsed = parseRef(ref);
  return parsed ? parsed.id : ref;
}

function nextOriginSeq(db: Database.Database, nodeId: string): number {
  return allocateOriginSeq(db, nodeId);
}

/** Allocates origin_seq once per transaction, matching store/write.ts's own seqAllocator. */
function seqAllocator(db: Database.Database, nodeId: string): () => number {
  let next = nextOriginSeq(db, nodeId);
  return () => next++;
}

function clientIdByName(db: Database.Database, name: string): string | undefined {
  return (db.prepare("SELECT client_id FROM clients WHERE name = ?").get(name) as { client_id: string } | undefined)?.client_id;
}

function clientIdBySession(db: Database.Database, sessionRef: string): string | undefined {
  return (db.prepare("SELECT client_id FROM sessions WHERE session_ref = ?").get(sessionRef) as { client_id: string } | undefined)?.client_id;
}

/** Best-effort resolution for a batch's already-persisted selector; never throws. */
function resolveSelectorClientId(db: Database.Database, selector: { client?: string; session?: string }): string | undefined {
  if (selector.client) return clientIdByName(db, selector.client);
  if (selector.session) return clientIdBySession(db, selector.session);
  return undefined;
}

/** Appends one event and materializes it in the same step, matching store/write.ts's pattern. No request_id: these are system/human cleanup events, not idempotent client requests. */
function appendAndApply(db: Database.Database, ctx: WriteContext, allocSeq: () => number, spec: HygieneEventSpec): void {
  db.prepare(
    `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    spec.eventId,
    ctx.nodeId,
    allocSeq(),
    spec.hlc,
    spec.scopeId,
    spec.entryId,
    spec.op,
    spec.part,
    canonicalJson(spec.parentRevs ?? []),
    spec.rev,
    ctx.clientId,
    canonicalJson(spec.payload),
    spec.prev ? canonicalJson(spec.prev) : null,
    nowIso(),
  );
  signStoredEvent(db, spec.eventId, ctx.flags);
  applyEvent(db, {
    eventId: spec.eventId,
    scopeId: spec.scopeId,
    entryId: spec.entryId,
    op: spec.op,
    part: spec.part,
    rev: spec.rev,
    clientId: ctx.clientId,
    hlc: spec.hlc,
    payload: spec.payload,
    prev: spec.prev ?? null,
  });
}

function loadBatch(db: Database.Database, batchId: string): BatchRow {
  const row = db.prepare("SELECT * FROM batches WHERE batch_id = ?").get(batchId) as BatchRow | undefined;
  if (!row) throw new CtxdError("NOT_FOUND", `Batch not found: ${batchId}`, {}, "batch_id");
  return row;
}

/** Exported for src/store/rollback.ts. */
export function isWithin(t: number, from: number | undefined, to: number): boolean {
  return (from === undefined || t >= from) && t <= to;
}

/**
 * `ctxd quarantine` (SPEC v6 7.6.2): human only. Selects events in the window matching the
 * selector on content/relations/status parts, hides every entry they touched, and suspends any
 * active claim the selected client holds in an affected scope.
 */
export function openQuarantine(ctx: WriteContext, selector: QuarantineSelector): QuarantineResult {
  const { db } = ctx;
  requireHuman(db, ctx.clientId, "quarantine");
  if (!selector.client && !selector.session) {
    throw new CtxdError("VALIDATION", "At least one of client or session is required", {}, "client");
  }

  let selClientId: string | undefined;
  if (selector.client) {
    selClientId = clientIdByName(db, selector.client);
    if (!selClientId) throw new CtxdError("NOT_FOUND", `Client not found: ${selector.client}`, {}, "client");
  }
  const sessionClientId = selector.session ? clientIdBySession(db, selector.session) : undefined;
  const resolvedClientId = selClientId ?? sessionClientId;

  let selScopeId: string | undefined;
  if (selector.scope) {
    const scope = loadScopeByName(db, selector.scope);
    if (!scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${selector.scope}`, {}, "scope");
    selScopeId = scope.id;
  }

  const openedAt = Date.now();
  const { from: fromMs, to } = timeWindow(selector.since, selector.until, openedAt);
  const toMs = to ?? openedAt;

  const rows = db
    .prepare("SELECT event_id, scope_id, entry_id, hlc, client_id, session_ref, part, op, rev, prev FROM events WHERE part IN ('content','relations','status')")
    .all() as SelEvent[];

  const selected = rows.filter((e) => {
    if (selClientId && e.client_id !== selClientId) return false;
    if (selector.session && e.session_ref !== selector.session) return false;
    if (selScopeId && e.scope_id !== selScopeId) return false;
    const t = decodeHlc(e.hlc).physical;
    return isWithin(t, fromMs, toMs);
  });
  if (selected.length === 0) throw new CtxdError("NOT_FOUND", "No events matched this selector", {}, "client");

  const byEntry = new Map<string, SelEvent[]>();
  for (const e of selected) {
    const list = byEntry.get(e.entry_id);
    if (list) list.push(e);
    else byEntry.set(e.entry_id, [e]);
  }

  const batchId = newId();
  const result = db.transaction(() => {
    const allocSeq = seqAllocator(db, ctx.nodeId);
    const createdHlc = ctx.clock.tick();

    const storedSelector: Record<string, unknown> = {
      ...(selector.client ? { client: selector.client } : {}),
      ...(selector.session ? { session: selector.session } : {}),
      // since/until are frozen as absolute instants at open time, so a later revert re-derives
      // exactly the same window regardless of when "now" is when it runs (ADR 0002's determinism
      // requirement: replay, and here re-selection, must not depend on a moving clock).
      ...(fromMs !== undefined ? { since: new Date(fromMs).toISOString() } : {}),
      until: new Date(toMs).toISOString(),
      ...(selector.scope ? { scope: selector.scope } : {}),
    };
    db.prepare("INSERT INTO batches (batch_id, kind, selector, state, created_by, created_hlc) VALUES (?, 'quarantine', ?, 'open', ?, ?)").run(
      batchId,
      canonicalJson(storedSelector),
      ctx.clientId,
      createdHlc,
    );

    let entriesHidden = 0;
    for (const [entryId, events] of byEntry) {
      const entry = db.prepare("SELECT scope_id, status, status_rev FROM entries WHERE entry_id = ?").get(entryId) as
        | { scope_id: string; status: string; status_rev: string }
        | undefined;
      if (!entry) continue; // purged or otherwise gone; nothing to hide or track

      const createRow = db.prepare("SELECT hlc FROM events WHERE entry_id = ? AND op = 'create'").get(entryId) as { hlc: string } | undefined;
      const createdInBatch = createRow ? isWithin(decodeHlc(createRow.hlc).physical, fromMs, toMs) : false;
      const firstEvent = events.reduce((min, e) => (e.hlc < min.hlc ? e : min));

      db.prepare("INSERT INTO batch_members (batch_id, entry_id, first_event, created_in_batch, outcome) VALUES (?, ?, ?, ?, NULL)").run(
        batchId,
        entryId,
        firstEvent.event_id,
        createdInBatch ? 1 : 0,
      );

      if (entry.status === "quarantined") continue; // already hidden by another open batch; still a tracked member here

      const eventId = newId();
      const hlc = ctx.clock.tick();
      const rev = makeRev(revVersion(entry.status_rev) + 1, eventId);
      appendAndApply(db, ctx, allocSeq, {
        scopeId: entry.scope_id,
        entryId,
        op: "quarantine",
        part: "status",
        rev,
        parentRevs: [entry.status_rev],
        payload: {},
        prev: { status: entry.status },
        eventId,
        hlc,
      });
      entriesHidden++;
    }

    let suspended = 0;
    if (resolvedClientId) {
      const scopeIds = [...new Set(selected.map((e) => e.scope_id))];
      const placeholders = scopeIds.map(() => "?").join(",");
      const leases = db
        .prepare(`SELECT task_id, scope_id FROM leases WHERE holder = ? AND state = 'active' AND suspended_at IS NULL AND scope_id IN (${placeholders})`)
        .all(resolvedClientId, ...scopeIds) as { task_id: string; scope_id: string }[];
      for (const lease of leases) {
        const eventId = newId();
        const hlc = ctx.clock.tick();
        appendAndApply(db, ctx, allocSeq, {
          scopeId: lease.scope_id,
          entryId: lease.task_id,
          op: "suspend",
          part: "claim",
          rev: makeRev(1, eventId),
          payload: { batch_id: batchId },
          prev: null,
          eventId,
          hlc,
        });
        suspended++;
      }
    }

    return { entries: byEntry.size, entriesHidden, suspended };
  })();

  return { batch_id: batchId, entries: result.entries, suspended_claims: result.suspended };
}

/** Resumes (unsuspends) every lease this batch's client still has suspended. Used by releaseBatch once a batch fully closes. */
function resumeSuspendedClaims(db: Database.Database, ctx: WriteContext, allocSeq: () => number, batch: BatchRow): void {
  const selector = JSON.parse(batch.selector) as { client?: string; session?: string };
  const resolvedClientId = resolveSelectorClientId(db, selector);
  if (!resolvedClientId) return;
  const leases = db.prepare("SELECT task_id, scope_id FROM leases WHERE holder = ? AND suspended_at IS NOT NULL").all(resolvedClientId) as {
    task_id: string;
    scope_id: string;
  }[];
  for (const lease of leases) {
    const eventId = newId();
    const hlc = ctx.clock.tick();
    appendAndApply(db, ctx, allocSeq, {
      scopeId: lease.scope_id,
      entryId: lease.task_id,
      op: "resume",
      part: "claim",
      rev: makeRev(1, eventId),
      payload: { batch_id: batch.batch_id },
      prev: null,
      eventId,
      hlc,
    });
  }
}

/** Releases every lease this batch's client still has suspended, with changed_files unknown (SPEC 7.6.3's "Claims" step). Reuses the ordinary claim/release materialize path, bypassing claim.ts's holder-or-human check: this is a system/human cleanup action on the batch's own suspended claims, not a client releasing its own work. */
function releaseSuspendedClaims(db: Database.Database, ctx: WriteContext, allocSeq: () => number, batch: BatchRow): void {
  const selector = JSON.parse(batch.selector) as { client?: string; session?: string };
  const resolvedClientId = resolveSelectorClientId(db, selector);
  if (!resolvedClientId) return;
  const leases = db.prepare("SELECT task_id, scope_id, claim_hlc FROM leases WHERE holder = ? AND suspended_at IS NOT NULL").all(resolvedClientId) as {
    task_id: string;
    scope_id: string;
    claim_hlc: string;
  }[];
  for (const lease of leases) {
    const eventId = newId();
    const hlc = ctx.clock.tick();
    appendAndApply(db, ctx, allocSeq, {
      scopeId: lease.scope_id,
      entryId: lease.task_id,
      op: "release",
      part: "claim",
      rev: makeRev(1, eventId),
      parentRevs: [lease.claim_hlc],
      payload: { changed_files: null, drift: null },
      prev: null,
      eventId,
      hlc,
    });
  }
}

function loadMembers(db: Database.Database, batchId: string, entryRef: string | undefined): { all: MemberRow[]; targets: MemberRow[] } {
  const all = db.prepare("SELECT * FROM batch_members WHERE batch_id = ?").all(batchId) as MemberRow[];
  if (all.length === 0) throw new CtxdError("NOT_FOUND", "Batch has no members", {}, "batch_id");
  const scopedEntryId = entryRef ? entryIdFromRef(entryRef) : undefined;
  if (scopedEntryId && !all.some((m) => m.entry_id === scopedEntryId)) {
    throw new CtxdError("NOT_FOUND", `Entry is not a member of this batch: ${entryRef}`, {}, "entry");
  }
  const targets = all.filter((m) => m.outcome === null && (!scopedEntryId || m.entry_id === scopedEntryId));
  return { all, targets };
}

/** Finalizes a batch's state once no open members remain, and runs the given per-kind completion (resume for release, release for revert). Returns the batch's current state either way. */
function finalizeIfDone(
  db: Database.Database,
  ctx: WriteContext,
  allocSeq: () => number,
  batch: BatchRow,
  expectedOutcome: string,
  onDone: (db: Database.Database, ctx: WriteContext, allocSeq: () => number, batch: BatchRow) => void,
): string {
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM batch_members WHERE batch_id = ? AND outcome IS NULL").get(batch.batch_id) as { n: number };
  if (remaining.n > 0) return batch.state;
  const outcomes = new Set(
    (db.prepare("SELECT outcome FROM batch_members WHERE batch_id = ?").all(batch.batch_id) as { outcome: string | null }[]).map((r) => r.outcome),
  );
  const newState = outcomes.size === 1 && outcomes.has(expectedOutcome) ? expectedOutcome : "partial";
  db.prepare("UPDATE batches SET state = ? WHERE batch_id = ?").run(newState, batch.batch_id);
  onDone(db, ctx, allocSeq, batch);
  return newState;
}

/**
 * `ctxd batch release <id> [--entry <ref>]` (SPEC v6 7.6.4): human only. Restores status_before
 * on every open member (or just `entryRef`); once the whole batch has no open members left,
 * resumes its suspended claims and moves the batch to released (or partial).
 */
export function releaseBatch(ctx: WriteContext, batchId: string, entryRef?: string): BatchActionResult {
  const { db } = ctx;
  requireHuman(db, ctx.clientId, "release");
  const batch = loadBatch(db, batchId);
  const { targets } = loadMembers(db, batchId, entryRef);

  const state = db.transaction(() => {
    const allocSeq = seqAllocator(db, ctx.nodeId);
    for (const member of targets) {
      const entry = db.prepare("SELECT scope_id, status, status_rev FROM entries WHERE entry_id = ?").get(member.entry_id) as
        | { scope_id: string; status: string; status_rev: string }
        | undefined;
      if (entry && entry.status === "quarantined") {
        const eventId = newId();
        const hlc = ctx.clock.tick();
        const rev = makeRev(revVersion(entry.status_rev) + 1, eventId);
        appendAndApply(db, ctx, allocSeq, {
          scopeId: entry.scope_id,
          entryId: member.entry_id,
          op: "unquarantine",
          part: "status",
          rev,
          parentRevs: [entry.status_rev],
          payload: {},
          prev: { status: entry.status },
          eventId,
          hlc,
        });
      }
      db.prepare("UPDATE batch_members SET outcome = 'released' WHERE batch_id = ? AND entry_id = ?").run(batchId, member.entry_id);
    }

    return finalizeIfDone(db, ctx, allocSeq, batch, "released", resumeSuspendedClaims);
  })();

  const members = db.prepare("SELECT entry_id, outcome FROM batch_members WHERE batch_id = ?").all(batchId) as { entry_id: string; outcome: string | null }[];
  return { batch_id: batchId, state, members };
}

/** Any event on `entryId`/`part` strictly after `untilMs` from a client other than `excludeClientId` (SPEC 7.6.3's "later edits by other sources"). */
function hasLaterConflict(db: Database.Database, entryId: string, part: string, untilMs: number, excludeClientId: string | undefined): boolean {
  const rows = db.prepare("SELECT hlc, client_id FROM events WHERE entry_id = ? AND part = ?").all(entryId, part) as { hlc: string; client_id: string }[];
  return rows.some((r) => decodeHlc(r.hlc).physical > untilMs && r.client_id !== excludeClientId);
}

/**
 * `ctxd batch revert <id> [--entry <ref>]` (SPEC v6 7.6.3): human only. Per open member (or just
 * `entryRef`): tombstones an entry created in the window, or restores one edited in the window
 * unless a later edit from another client conflicts (in which case it becomes `conflicted` and
 * the would-be-reverted content is kept as a sibling). Once the whole batch has no open members
 * left, releases its suspended claims and moves the batch to reverted (or partial).
 */
export function revertBatch(ctx: WriteContext, batchId: string, entryRef?: string): BatchActionResult {
  const { db } = ctx;
  requireHuman(db, ctx.clientId, "revert");
  const batch = loadBatch(db, batchId);
  const selector = JSON.parse(batch.selector) as { client?: string; session?: string; since?: string; until: string; scope?: string };
  const resolvedClientId = resolveSelectorClientId(db, selector);
  const sinceMs = selector.since !== undefined ? Date.parse(selector.since) : undefined;
  const untilMs = Date.parse(selector.until);
  const { targets } = loadMembers(db, batchId, entryRef);

  const state = db.transaction(() => {
    const allocSeq = seqAllocator(db, ctx.nodeId);

    for (const member of targets) {
      const entry = db.prepare("SELECT scope_id, status, status_rev, content_rev, relations_rev FROM entries WHERE entry_id = ?").get(
        member.entry_id,
      ) as { scope_id: string; status: string; status_rev: string; content_rev: string; relations_rev: string } | undefined;
      if (!entry) {
        db.prepare("UPDATE batch_members SET outcome = 'reverted' WHERE batch_id = ? AND entry_id = ?").run(batchId, member.entry_id);
        continue;
      }

      if (member.created_in_batch) {
        const eventId = newId();
        const hlc = ctx.clock.tick();
        const rev = makeRev(revVersion(entry.status_rev) + 1, eventId);
        appendAndApply(db, ctx, allocSeq, {
          scopeId: entry.scope_id,
          entryId: member.entry_id,
          op: "delete",
          part: "content",
          rev,
          parentRevs: [entry.status_rev],
          payload: {},
          prev: { status: entry.status },
          eventId,
          hlc,
        });
        db.prepare("UPDATE batch_members SET outcome = 'reverted' WHERE batch_id = ? AND entry_id = ?").run(batchId, member.entry_id);
        continue;
      }

      // "Edited in the window": re-select this entry's events against the batch's own frozen
      // window (never a re-parsed "7d" against a new "now" -- the window was resolved to
      // absolute instants when the batch opened).
      const windowEvents = (
        db
          .prepare("SELECT event_id, part, op, hlc, client_id, rev, prev FROM events WHERE entry_id = ? AND part IN ('content','relations') ORDER BY hlc")
          .all(member.entry_id) as { event_id: string; part: "content" | "relations"; op: string; hlc: string; client_id: string; rev: string; prev: string | null }[]
      ).filter((e) => {
        if (resolvedClientId && e.client_id !== resolvedClientId) return false;
        const t = decodeHlc(e.hlc).physical;
        return isWithin(t, sinceMs, untilMs);
      });

      const partsTouched = [...new Set(windowEvents.map((e) => e.part))];
      // The client being reverted never counts as "another source" of its own would-be-reverted
      // edit; only an event from a *different* client after the window blocks the revert.
      const conflicted = partsTouched.some((part) => hasLaterConflict(db, member.entry_id, part, untilMs, resolvedClientId));

      if (conflicted) {
        for (const part of partsTouched) {
          const earliest = windowEvents.find((e) => e.part === part);
          if (earliest) {
            recordSibling(db, member.entry_id, part, earliest.rev, earliest.event_id, "revert-conflict");
          }
        }
        if (entry.status !== "conflicted") {
          const eventId = newId();
          const hlc = ctx.clock.tick();
          const rev = makeRev(revVersion(entry.status_rev) + 1, eventId);
          appendAndApply(db, ctx, allocSeq, {
            scopeId: entry.scope_id,
            entryId: member.entry_id,
            op: "status",
            part: "status",
            rev,
            parentRevs: [entry.status_rev],
            payload: { status: "conflicted" },
            prev: { status: entry.status },
            eventId,
            hlc,
          });
        }
        db.prepare("UPDATE batch_members SET outcome = 'conflict' WHERE batch_id = ? AND entry_id = ?").run(batchId, member.entry_id);
        continue;
      }

      // Content: restore exactly the fields the earliest selected content event's `prev` names.
      const earliestContent = windowEvents.find((e) => e.part === "content");
      if (earliestContent?.prev) {
        const priorFields = JSON.parse(earliestContent.prev) as Record<string, unknown>;
        const current = db.prepare("SELECT content_rev FROM entries WHERE entry_id = ?").get(member.entry_id) as { content_rev: string };
        const eventId = newId();
        const hlc = ctx.clock.tick();
        const rev = makeRev(revVersion(current.content_rev) + 1, eventId);
        appendAndApply(db, ctx, allocSeq, {
          scopeId: entry.scope_id,
          entryId: member.entry_id,
          op: "update",
          part: "content",
          rev,
          parentRevs: [current.content_rev],
          payload: priorFields,
          prev: null,
          eventId,
          hlc,
        });
      }

      // Relations: unrelate every link added in the window.
      for (const e of windowEvents) {
        if (e.part !== "relations" || e.op !== "relate") continue;
        const linkRow = db.prepare("SELECT link_id FROM relations WHERE added_event = ? AND removed_event IS NULL").get(e.event_id) as
          | { link_id: string }
          | undefined;
        if (!linkRow) continue; // already removed since
        const relEntry = db.prepare("SELECT relations_rev FROM entries WHERE entry_id = ?").get(member.entry_id) as { relations_rev: string };
        const eventId = newId();
        const hlc = ctx.clock.tick();
        const rev = makeRev(revVersion(relEntry.relations_rev) + 1, eventId);
        appendAndApply(db, ctx, allocSeq, {
          scopeId: entry.scope_id,
          entryId: member.entry_id,
          op: "unrelate",
          part: "relations",
          rev,
          parentRevs: [relEntry.relations_rev],
          payload: { link_id: linkRow.link_id },
          prev: null,
          eventId,
          hlc,
        });
      }

      // Status: restored to status_before (SPEC 7.6.3), exactly release's own semantics.
      const afterEdits = db.prepare("SELECT status, status_rev FROM entries WHERE entry_id = ?").get(member.entry_id) as {
        status: string;
        status_rev: string;
      };
      if (afterEdits.status === "quarantined") {
        const eventId = newId();
        const hlc = ctx.clock.tick();
        const rev = makeRev(revVersion(afterEdits.status_rev) + 1, eventId);
        appendAndApply(db, ctx, allocSeq, {
          scopeId: entry.scope_id,
          entryId: member.entry_id,
          op: "unquarantine",
          part: "status",
          rev,
          parentRevs: [afterEdits.status_rev],
          payload: {},
          prev: { status: afterEdits.status },
          eventId,
          hlc,
        });
      }

      db.prepare("UPDATE batch_members SET outcome = 'reverted' WHERE batch_id = ? AND entry_id = ?").run(batchId, member.entry_id);
    }

    return finalizeIfDone(db, ctx, allocSeq, batch, "reverted", releaseSuspendedClaims);
  })();

  const members = db.prepare("SELECT entry_id, outcome FROM batch_members WHERE batch_id = ?").all(batchId) as { entry_id: string; outcome: string | null }[];
  return { batch_id: batchId, state, members };
}

/** `ctxd batch show <id>`: read-only, no vendor check (anyone who can read the data directory can inspect a batch). */
export function showBatch(db: Database.Database, batchId: string): BatchShowResult {
  const batch = loadBatch(db, batchId);
  const members = (
    db.prepare("SELECT entry_id, first_event, created_in_batch, outcome FROM batch_members WHERE batch_id = ?").all(batchId) as {
      entry_id: string;
      first_event: string;
      created_in_batch: number;
      outcome: string | null;
    }[]
  ).map((m) => ({ entry_id: m.entry_id, first_event: m.first_event, created_in_batch: m.created_in_batch === 1, outcome: m.outcome }));
  return {
    batch_id: batch.batch_id,
    kind: batch.kind,
    selector: JSON.parse(batch.selector) as Record<string, unknown>,
    state: batch.state,
    created_by: batch.created_by,
    created_hlc: batch.created_hlc,
    members,
  };
}
