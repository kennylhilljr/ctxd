import type Database from "better-sqlite3";
import { accessLevel, atLeast, type ClientInfo } from "../access/level.js";
import { makeRev, newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { CtxdError } from "../core/errors.js";
import { formatRef, parseRef } from "../model/refs.js";
import { IntentError, computeDrift, normalizeChangedPath, normalizeIntent, type OverlapPair } from "../claims/intent.js";
import { persistOverlaps, scanOverlappingLeases } from "../claims/overlap.js";
import { canonicalJson, requestHash } from "./idempotency.js";
import { applyEvent } from "./materialize.js";
import { loadAccessSnapshot, loadClient, loadClientName, loadScopeByName } from "./snapshot.js";
import { writeEntry, type WriteContext } from "./write.js";

/**
 * context_claim (SPEC v6 section 7.5): claims are events in the task entry's history; `leases`
 * is materialized from them, one row per task_id (overwritten on each claim/release, not a full
 * history; the event log keeps that).
 *
 * M2 slice 9 ("claims, complete") resolved the M1 gaps this file used to flag at the top:
 * `session_ref` and `base_head` are now recorded at claim time (from the caller's `session` and
 * the matching `sessions.head`, itself now written by the hook dispatcher); `holder_session_state`
 * and `commits_since_claim` read real data; and release derives `changed_files` from recorded
 * commit pointers when the caller omits them.
 *
 * Still open, by design:
 * - Release's derivation only covers "commit pointers recorded by PostToolUse" (SPEC 7.5.4); the
 *   other half, "working-tree changes in the latest PreCompact/Stop/SessionEnd checkpoint," needs
 *   the hook's per-session checkpoint *file*, and neither `WriteContext` nor `RequestContext`
 *   carries a data directory to find it from an MCP tool call. Wiring that through is a separate,
 *   broader change, not a one-line addition here.
 * - Mechanical release for a *crashed* session (the sweep, src/hooks/crashSweep.ts) still can't
 *   verify "working tree clean," since a crashed session has no live `cwd` to check; SessionEnd's
 *   own mechanical release (src/hooks/writeMoments.ts) can, because it runs in the real session.
 * - Quarantine-driven claim suspension (7.6.2) isn't implemented; quarantine itself was out of
 *   scope for M1 and is a separate M2 slice (hygiene).
 */

export interface ClaimInput {
  scope: string;
  action: "claim" | "release" | "list";
  task_id?: string;
  title?: string;
  paths?: string[];
  take_over?: boolean;
  changed_files?: string[];
  ttl_minutes: number;
  request_id?: string;
  /** The calling hook session's reference ("<client>:<session id>"), for session_ref/base_head and the drift audit. */
  session?: string;
}

interface LeaseRow {
  task_id: string;
  scope_id: string;
  holder: string;
  state: string;
  paths: string | null;
  claim_hlc: string;
  session_ref: string | null;
  base_head: string | null;
  expires_at: string;
  changed_files: string | null;
  drift: string | null;
  tentative: number;
}

interface LeaseOut {
  task_id: string;
  ref: string;
  title: string;
  holder: string;
  state: string;
  paths: string[] | null;
  expires_at: string;
  tentative: boolean;
}

interface OverlapOut {
  task_id: string;
  ref: string;
  holder: string;
  patterns: OverlapPair[];
}

export function handleClaim(ctx: WriteContext, input: ClaimInput): unknown {
  const { db } = ctx;
  const scope = loadScopeByName(db, input.scope);
  if (!scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${input.scope}`);
  const client = loadClient(db, ctx.clientId);
  if (!client) throw new CtxdError("UNAUTHORIZED", "Unknown or revoked client");
  const snapshot = loadAccessSnapshot(db);
  const level = accessLevel(client, scope, snapshot, Date.now(), ctx.assumedPools);

  if (input.action === "list") {
    if (!atLeast(level, "read")) throw new CtxdError("SCOPE_FORBIDDEN", `No access to scope: ${scope.name}`);
    return listClaims(db, scope);
  }
  if (!atLeast(level, "propose")) throw new CtxdError("SCOPE_FORBIDDEN", `No access to scope: ${scope.name}`);
  return input.action === "claim" ? claimTask(ctx, input, scope, client) : releaseTask(ctx, input, scope, client);
}

function toLeaseOut(db: Database.Database, scope: { name: string }, row: LeaseRow): LeaseOut {
  const entry = db.prepare("SELECT title FROM entries WHERE entry_id = ?").get(row.task_id) as { title: string } | undefined;
  return {
    task_id: row.task_id,
    ref: formatRef(scope.name, row.task_id),
    title: entry?.title ?? "",
    holder: loadClientName(db, row.holder),
    state: row.state,
    paths: row.paths !== null ? (JSON.parse(row.paths) as string[]) : null,
    expires_at: row.expires_at,
    tentative: row.tentative === 1,
  };
}

function normalizePathsOrThrow(paths: string[] | undefined): string[] | undefined {
  try {
    return normalizeIntent(paths);
  } catch (err) {
    throw new CtxdError("VALIDATION", (err as IntentError).message, {}, "paths");
  }
}

function resolveOrCreateTask(ctx: WriteContext, input: ClaimInput, scope: { id: string; name: string }): { id: string } {
  const { db } = ctx;
  if (input.task_id) {
    const parsed = parseRef(input.task_id);
    const id = parsed ? parsed.id : input.task_id;
    const row = db.prepare("SELECT entry_id, scope_id, kind FROM entries WHERE entry_id = ?").get(id) as
      | { entry_id: string; scope_id: string; kind: string }
      | undefined;
    if (!row || row.scope_id !== scope.id) throw new CtxdError("NOT_FOUND", `Task not found: ${input.task_id}`, {}, "task_id");
    if (row.kind !== "task") throw new CtxdError("VALIDATION", "task_id must reference a task entry", {}, "task_id");
    return { id: row.entry_id };
  }
  if (input.title) {
    const result = writeEntry(
      { db, clock: ctx.clock, nodeId: ctx.nodeId, clientId: ctx.clientId, assumedPools: ctx.assumedPools },
      { scope: scope.name, kind: "task", title: input.title, body: input.title, request_id: newId() } as never,
    );
    if ("held" in result) throw new Error("unreachable: claim already checked for at-least-propose access on this scope");
    return { id: result.id };
  }
  throw new CtxdError("VALIDATION", "task_id or title is required", {}, "task_id");
}

function nextOriginSeq(db: Database.Database, nodeId: string): number {
  return (db.prepare("SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM events WHERE origin_node = ?").get(nodeId) as { next: number })
    .next;
}

/** The session's last-observed git HEAD (src/cli/hook.ts writes this on every hook call), or null if unknown. */
function sessionHead(db: Database.Database, sessionRef: string): string | null {
  const row = db.prepare("SELECT head FROM sessions WHERE session_ref = ?").get(sessionRef) as { head: string | null } | undefined;
  return row?.head ?? null;
}

const TENTATIVE_AFTER_MS = 10 * 60_000;

/**
 * Spec 7.4: "Claims made while a node has had no successful sync for 10 minutes are flagged
 * tentative." A node with no peers at all has nothing to be partitioned from, so it is exempt
 * (every claim behaves exactly as it did before sync existed); one with peers is tentative from
 * the moment 10 minutes pass with no peer's `last_synced_at` refreshed (src/sync/pull.ts sets it
 * on every successful pull, whether or not `sync` is currently switched on for this node).
 */
function isTentative(db: Database.Database): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n, MAX(last_synced_at) AS latest FROM peers WHERE revoked_at IS NULL").get() as {
    n: number;
    latest: string | null;
  };
  if (row.n === 0) return false;
  if (row.latest === null) return true;
  return Date.now() - Date.parse(row.latest) >= TENTATIVE_AFTER_MS;
}

function claimTask(ctx: WriteContext, input: ClaimInput, scope: { id: string; name: string }, client: ClientInfo): unknown {
  const { db } = ctx;
  const claimHash = (): string =>
    requestHash({ scope: input.scope, action: "claim", task_id: input.task_id, title: input.title, paths: input.paths, ttl_minutes: input.ttl_minutes });

  if (input.request_id) {
    const existing = db
      .prepare("SELECT entry_id, request_hash FROM events WHERE client_id = ? AND request_id = ?")
      .get(ctx.clientId, input.request_id) as { entry_id: string; request_hash: string } | undefined;
    if (existing) {
      if (existing.request_hash !== claimHash()) throw new CtxdError("IDEMPOTENCY_MISMATCH", "request_id was already used with different input");
      const lease = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(existing.entry_id) as LeaseRow;
      return { lease: toLeaseOut(db, scope, lease), overlaps: [], intent_unknown: [] };
    }
  }

  const task = resolveOrCreateTask(ctx, input, scope);
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(task.id) as LeaseRow | undefined;

  let takenOverFrom: string | null = null;
  if (existing && existing.state === "active") {
    const isExpired = now > Date.parse(existing.expires_at);
    if (!isExpired && existing.holder !== ctx.clientId) {
      throw new CtxdError("CLAIM_HELD", "Task is already claimed", { holder: loadClientName(db, existing.holder), expires_at: existing.expires_at });
    }
    if (isExpired && !input.take_over) {
      throw buildClaimStale(db, scope, existing);
    }
    if (isExpired && existing.holder !== ctx.clientId) {
      takenOverFrom = existing.holder;
    }
  }

  const myPaths = input.paths !== undefined ? normalizePathsOrThrow(input.paths) : existing?.paths ? (JSON.parse(existing.paths) as string[]) : undefined;

  // Suspended leases (SPEC 7.6.2 step 4) no longer block other agents: overlap detection ignores them.
  const scan = scanOverlappingLeases(db, scope.id, task.id, myPaths);
  const overlaps: OverlapOut[] = scan.overlaps.map((o) => ({ task_id: o.taskId, ref: formatRef(scope.name, o.taskId), holder: loadClientName(db, o.holder), patterns: o.pairs }));
  const intentUnknown = scan.intentUnknown;

  const intentPolicy = (db.prepare("SELECT intent_policy FROM scopes WHERE scope_id = ?").get(scope.id) as { intent_policy: string }).intent_policy;
  if (intentPolicy === "strict" && overlaps.length > 0 && !(client.vendor === "human" && input.take_over)) {
    throw new CtxdError("CLAIM_OVERLAP", "This claim overlaps an existing one", { overlaps });
  }

  const eventId = newId();
  const hlc = ctx.clock.tick();
  const sessionRef = input.session ?? null;
  const baseHead = sessionRef ? sessionHead(db, sessionRef) : null;
  // Spec 7.3's parent-vs-head check (src/sync/apply.ts's `decide`) needs a real parent to tell a
  // genuinely concurrent claim (made offline, unaware of this one) from a renewal or take-over of
  // this exact lease: the prior claim_hlc when one is active (even expired), nothing otherwise.
  const parentRevs = existing && existing.state === "active" ? [existing.claim_hlc] : [];
  const payload = {
    holder: ctx.clientId,
    paths: myPaths ?? null,
    ttl_minutes: input.ttl_minutes,
    session_ref: sessionRef,
    base_head: baseHead,
    taken_over_from: takenOverFrom,
    tentative: isTentative(db),
  };
  const rev = makeRev(1, eventId);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'claim', 'claim', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      eventId,
      ctx.nodeId,
      nextOriginSeq(db, ctx.nodeId),
      hlc,
      scope.id,
      task.id,
      canonicalJson(parentRevs),
      rev,
      ctx.clientId,
      sessionRef,
      input.request_id ?? null,
      input.request_id ? claimHash() : null,
      canonicalJson(payload),
      nowIso(),
    );
    applyEvent(db, { eventId, scopeId: scope.id, entryId: task.id, op: "claim", part: "claim", rev, clientId: ctx.clientId, hlc, payload, prev: null });
    // Persisted here too, not just when a replicated claim finds the same thing (Spec 7.4,
    // src/store/materialize.ts's recordClaimOverlaps): so `ctxd rebuild`, which replays every
    // event through the replicated path regardless of where it first originated, reproduces
    // these same rows instead of creating ones this live claim never wrote.
    persistOverlaps(db, task.id, hlc, intentPolicy, scan.overlaps, "claim");
  })();

  const lease = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(task.id) as LeaseRow;
  return { lease: toLeaseOut(db, scope, lease), overlaps, intent_unknown: intentUnknown };
}

/** The holder's session state (SPEC 7.5.5), or "unknown" if the claim predates session_ref or the session row is gone. */
function holderSessionState(db: Database.Database, lease: LeaseRow): string {
  if (!lease.session_ref) return "unknown";
  const row = db.prepare("SELECT state FROM sessions WHERE session_ref = ?").get(lease.session_ref) as { state: string } | undefined;
  return row?.state ?? "unknown";
}

/** Up to 10 commit pointers (SPEC 7.5.5) journaled by the holder in this scope since the claim, newest first. */
function commitsSinceClaim(db: Database.Database, lease: LeaseRow): { sha: string; subject: string }[] {
  const rows = db
    .prepare(
      `SELECT e.title AS subject, r.target AS target FROM relations r JOIN entries e ON e.entry_id = r.entry_id
       WHERE r.type = 'points_to' AND r.target LIKE 'commit:%' AND r.removed_event IS NULL
         AND e.scope_id = ? AND e.created_by = ? AND e.created_hlc > ?
       ORDER BY e.created_hlc DESC LIMIT 10`,
    )
    .all(lease.scope_id, lease.holder, lease.claim_hlc) as { subject: string; target: string }[];
  return rows.map((r) => ({ sha: r.target.slice("commit:".length), subject: r.subject }));
}

function buildClaimStale(db: Database.Database, scope: { name: string }, lease: LeaseRow): CtxdError {
  const handoffs = db
    .prepare(
      "SELECT entry_id, title, updated_hlc FROM entries WHERE scope_id = ? AND kind = 'handoff' AND created_by = ? AND updated_hlc > ? ORDER BY updated_hlc DESC LIMIT 3",
    )
    .all(lease.scope_id, lease.holder, lease.claim_hlc) as { entry_id: string; title: string; updated_hlc: string }[];
  return new CtxdError(
    "CLAIM_STALE",
    "This task's claim expired",
    {
      holder: loadClientName(db, lease.holder),
      claimed_at: lease.claim_hlc,
      expired_at: lease.expires_at,
      holder_session_state: holderSessionState(db, lease),
      commits_since_claim: commitsSinceClaim(db, lease),
      handoffs_since_claim: handoffs.map((h) => ({ id: h.entry_id, title: h.title, at: h.updated_hlc })),
      paths: lease.paths !== null ? (JSON.parse(lease.paths) as string[]) : null,
    },
    undefined,
    "Check whether this work is already done before taking over. Retry with take_over: true to proceed.",
  );
}

/** Files from journaled commit pointers (W4) by the holder in this scope since the claim, deduped. */
function commitPointerChangedFiles(db: Database.Database, lease: LeaseRow): string[] {
  const rows = db
    .prepare(
      `SELECT e.body AS body FROM relations r JOIN entries e ON e.entry_id = r.entry_id
       WHERE r.type = 'points_to' AND r.target LIKE 'commit:%' AND r.removed_event IS NULL
         AND e.scope_id = ? AND e.created_by = ? AND e.created_hlc > ?`,
    )
    .all(lease.scope_id, lease.holder, lease.claim_hlc) as { body: string }[];
  const files = new Set<string>();
  for (const row of rows) {
    if (row.body === "(no file list)") continue;
    for (const line of row.body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  }
  return [...files];
}

function releaseTask(ctx: WriteContext, input: ClaimInput, scope: { id: string; name: string }, client: ClientInfo): unknown {
  const { db } = ctx;
  if (!input.task_id) throw new CtxdError("VALIDATION", "task_id is required to release a claim", {}, "task_id");
  const parsed = parseRef(input.task_id);
  const taskId = parsed ? parsed.id : input.task_id;

  const lease = db.prepare("SELECT * FROM leases WHERE task_id = ? AND scope_id = ?").get(taskId, scope.id) as LeaseRow | undefined;
  if (!lease || lease.state !== "active") throw new CtxdError("NOT_FOUND", "No active claim on this task", {}, "task_id");
  if (lease.holder !== ctx.clientId && client.vendor !== "human") {
    throw new CtxdError("NOT_ALLOWED", "Only the holder or the human client can release this claim");
  }

  let changedFiles: string[] | null = null;
  if (input.changed_files !== undefined) {
    try {
      changedFiles = [...new Set(input.changed_files.map(normalizeChangedPath))];
    } catch (err) {
      throw new CtxdError("VALIDATION", (err as IntentError).message, {}, "changed_files");
    }
  } else {
    // "Derived from git" (SPEC 7.5.4): the union of files in commit pointers the PostToolUse hook
    // recorded for the holder in this scope since the claim (src/hooks/writeMoments.ts's W4).
    // The other half of that derivation, working-tree changes from the latest checkpoint *file*,
    // is out of reach here (see this file's top note) and is not attempted.
    const derived = commitPointerChangedFiles(db, lease);
    changedFiles = derived.length > 0 ? derived : null;
  }

  const leasePaths = lease.paths !== null ? (JSON.parse(lease.paths) as string[]) : undefined;
  const drift = changedFiles !== null ? (computeDrift(leasePaths, changedFiles) ?? null) : null;

  const eventId = newId();
  const hlc = ctx.clock.tick();
  const sessionRef = input.session ?? null;
  const payload = { changed_files: changedFiles, drift };
  const rev = makeRev(1, eventId);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'release', 'claim', ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
    ).run(eventId, ctx.nodeId, nextOriginSeq(db, ctx.nodeId), hlc, scope.id, taskId, canonicalJson([lease.claim_hlc]), rev, ctx.clientId, sessionRef, input.request_id ?? null, canonicalJson(payload), nowIso());
    applyEvent(db, { eventId, scopeId: scope.id, entryId: taskId, op: "release", part: "claim", rev, clientId: ctx.clientId, hlc, payload, prev: null });
  })();

  const released = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) as LeaseRow;
  return { lease: toLeaseOut(db, scope, released), changed_files: changedFiles, drift };
}

function listClaims(db: Database.Database, scope: { id: string; name: string }): unknown {
  const rows = db.prepare("SELECT * FROM leases WHERE scope_id = ? ORDER BY claim_hlc DESC").all(scope.id) as LeaseRow[];
  return { leases: rows.map((r) => toLeaseOut(db, scope, r)) };
}
