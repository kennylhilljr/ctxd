import type Database from "better-sqlite3";
import { accessLevel, atLeast, type ClientInfo } from "../access/level.js";
import { makeRev, newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { CtxdError } from "../core/errors.js";
import { formatRef, parseRef } from "../model/refs.js";
import { IntentError, computeDrift, intentOverlaps, normalizeChangedPath, normalizeIntent, type OverlapPair } from "../claims/intent.js";
import { canonicalJson, requestHash } from "./idempotency.js";
import { applyEvent } from "./materialize.js";
import { loadAccessSnapshot, loadClient, loadClientName, loadScopeByName } from "./snapshot.js";
import { writeEntry, type WriteContext } from "./write.js";

/**
 * context_claim (SPEC v6 section 7.5): claims are events in the task entry's history; `leases`
 * is materialized from them, one row per task_id (overwritten on each claim/release, not a full
 * history -- the event log keeps that).
 *
 * M1 scope notes (flagged for SPEC-v7, not silently cut):
 * - `release`'s "derived from git" changed_files path (hook-recorded commit/checkpoint facts,
 *   SPEC 7.5.4) needs hooks, which land in M2. Without `changed_files` supplied by the caller,
 *   this always records it as unknown (null), never computes drift, and never fails.
 * - CLAIM_STALE's `holder_session_state` always reports "unknown" (the `sessions` table has no
 *   writer until the hook lifecycle lands) and `commits_since_claim` is always [] (no
 *   commit-pointer table exists yet in this schema).
 * - Mechanical release on session end and the crash sweep for orphaned ("lost") leases are both
 *   hook/daemon concerns with no M1 equivalent; a lease only ever leaves `active` through an
 *   explicit `claim`/`release` call in this slice.
 * - Quarantine-driven claim suspension (7.6.2) isn't implemented; quarantine itself is out of
 *   scope for M1.
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
}

interface LeaseRow {
  task_id: string;
  scope_id: string;
  holder: string;
  state: string;
  paths: string | null;
  claim_hlc: string;
  expires_at: string;
  changed_files: string | null;
  drift: string | null;
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
    tentative: false,
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
  const otherActive = db
    .prepare("SELECT task_id, holder, paths FROM leases WHERE scope_id = ? AND state = 'active' AND task_id != ? AND suspended_at IS NULL")
    .all(scope.id, task.id) as { task_id: string; holder: string; paths: string | null }[];
  const overlaps: OverlapOut[] = [];
  const intentUnknown: string[] = [];
  for (const other of otherActive) {
    const otherPaths = other.paths !== null ? (JSON.parse(other.paths) as string[]) : undefined;
    if (myPaths === undefined || otherPaths === undefined) {
      intentUnknown.push(other.task_id);
      continue;
    }
    const pairs = intentOverlaps(myPaths, otherPaths);
    if (pairs.length > 0) {
      overlaps.push({ task_id: other.task_id, ref: formatRef(scope.name, other.task_id), holder: loadClientName(db, other.holder), patterns: pairs });
    }
  }

  const intentPolicy = (db.prepare("SELECT intent_policy FROM scopes WHERE scope_id = ?").get(scope.id) as { intent_policy: string }).intent_policy;
  if (intentPolicy === "strict" && overlaps.length > 0 && !(client.vendor === "human" && input.take_over)) {
    throw new CtxdError("CLAIM_OVERLAP", "This claim overlaps an existing one", { overlaps });
  }

  const eventId = newId();
  const hlc = ctx.clock.tick();
  const payload = { holder: ctx.clientId, paths: myPaths ?? null, ttl_minutes: input.ttl_minutes, session_ref: null, taken_over_from: takenOverFrom };
  const rev = makeRev(1, eventId);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'claim', 'claim', '[]', ?, ?, NULL, ?, ?, ?, NULL, ?)`,
    ).run(eventId, ctx.nodeId, nextOriginSeq(db, ctx.nodeId), hlc, scope.id, task.id, rev, ctx.clientId, input.request_id ?? null, input.request_id ? claimHash() : null, canonicalJson(payload), nowIso());
    applyEvent(db, { eventId, scopeId: scope.id, entryId: task.id, op: "claim", part: "claim", rev, clientId: ctx.clientId, hlc, payload, prev: null });
  })();

  const lease = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(task.id) as LeaseRow;
  return { lease: toLeaseOut(db, scope, lease), overlaps, intent_unknown: intentUnknown };
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
      // Both depend on hook-recorded facts this M1 build doesn't have yet (see this file's top note).
      holder_session_state: "unknown",
      commits_since_claim: [],
      handoffs_since_claim: handoffs.map((h) => ({ id: h.entry_id, title: h.title, at: h.updated_hlc })),
      paths: lease.paths !== null ? (JSON.parse(lease.paths) as string[]) : null,
    },
    undefined,
    "Check whether this work is already done before taking over. Retry with take_over: true to proceed.",
  );
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
  }
  // "Derived from git" (SPEC 7.5.4) needs hook-recorded commit/checkpoint facts that don't exist
  // in M1; without agent-supplied changed_files, this always falls through to "unknown" (null).

  const leasePaths = lease.paths !== null ? (JSON.parse(lease.paths) as string[]) : undefined;
  const drift = changedFiles !== null ? (computeDrift(leasePaths, changedFiles) ?? null) : null;

  const eventId = newId();
  const hlc = ctx.clock.tick();
  const payload = { changed_files: changedFiles, drift };
  const rev = makeRev(1, eventId);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'release', 'claim', ?, ?, ?, NULL, ?, NULL, ?, NULL, ?)`,
    ).run(eventId, ctx.nodeId, nextOriginSeq(db, ctx.nodeId), hlc, scope.id, taskId, canonicalJson([lease.claim_hlc]), rev, ctx.clientId, input.request_id ?? null, canonicalJson(payload), nowIso());
    applyEvent(db, { eventId, scopeId: scope.id, entryId: taskId, op: "release", part: "claim", rev, clientId: ctx.clientId, hlc, payload, prev: null });
  })();

  const released = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) as LeaseRow;
  return { lease: toLeaseOut(db, scope, released), changed_files: changedFiles, drift };
}

function listClaims(db: Database.Database, scope: { id: string; name: string }): unknown {
  const rows = db.prepare("SELECT * FROM leases WHERE scope_id = ? ORDER BY claim_hlc DESC").all(scope.id) as LeaseRow[];
  return { leases: rows.map((r) => toLeaseOut(db, scope, r)) };
}
