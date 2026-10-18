import type Database from "better-sqlite3";
import { accessLevel, atLeast } from "../access/level.js";
import { makeRev, newId, revVersion } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type { FlagProblem } from "../core/kinds.js";
import { CtxdError } from "../core/errors.js";
import { parseRef } from "../model/refs.js";
import { canonicalJson, requestHash } from "./idempotency.js";
import { applyEvent } from "./materialize.js";
import { loadAccessSnapshot, loadClient, loadScopeById } from "./snapshot.js";
import type { WriteContext } from "./write.js";

/**
 * context_flag (SPEC v6 section 7.6.1): any client with at least `read` access to the entry's
 * scope may flag it, including an agent that could never write there. Flagging never goes
 * through the normal content-write access gate (no hold), since it only records metadata.
 */

export interface FlagInput {
  ref: string;
  problem: FlagProblem;
  reason: string;
  request_id?: string;
}

export interface FlagResult {
  ref: string;
  status: "flagged";
  flags: number;
}

export function flagEntry(ctx: WriteContext, input: FlagInput): FlagResult {
  const { db } = ctx;
  const parsed = parseRef(input.ref);
  const id = parsed ? parsed.id : input.ref;
  const row = db.prepare("SELECT entry_id, scope_id FROM entries WHERE entry_id = ?").get(id) as
    | { entry_id: string; scope_id: string }
    | undefined;
  if (!row) throw new CtxdError("NOT_FOUND", `Entry not found: ${input.ref}`, {}, "ref");

  const client = loadClient(db, ctx.clientId);
  if (!client) throw new CtxdError("UNAUTHORIZED", "Unknown or revoked client");
  const scope = loadScopeById(db, row.scope_id);
  if (!scope) throw new CtxdError("NOT_FOUND", "The entry's scope no longer exists");
  const snapshot = loadAccessSnapshot(db);
  if (!atLeast(accessLevel(client, scope, snapshot, Date.now(), ctx.assumedPools), "read")) {
    throw new CtxdError("SCOPE_FORBIDDEN", `No access to scope: ${scope.name}`);
  }

  const hash = requestHash({ ref: input.ref, problem: input.problem, reason: input.reason });
  if (input.request_id) {
    const existing = db
      .prepare("SELECT entry_id, request_hash FROM events WHERE client_id = ? AND request_id = ?")
      .get(ctx.clientId, input.request_id) as { entry_id: string; request_hash: string } | undefined;
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new CtxdError("IDEMPOTENCY_MISMATCH", "request_id was already used with different input");
      }
      return flagResult(db, row.entry_id, input.ref);
    }
  }

  const eventId = newId();
  const hlc = ctx.clock.tick();
  const flagId = newId();
  const nextOriginSeq = (
    db.prepare("SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM events WHERE origin_node = ?").get(ctx.nodeId) as { next: number }
  ).next;
  // Only the first open flag actually bumps status_rev (materialize.ts leaves it alone once an
  // entry is already flagged); this rev is only ever consumed on that path, but it still has to
  // be a well-formed rev string, since a later flag/status event builds the next one from it.
  const currentStatusRev = (db.prepare("SELECT status_rev FROM entries WHERE entry_id = ?").get(row.entry_id) as { status_rev: string }).status_rev;
  const rev = makeRev(revVersion(currentStatusRev) + 1, eventId);
  const payload = { flag_id: flagId, problem: input.problem, reason: input.reason };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'flag', 'status', ?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
    ).run(
      eventId,
      ctx.nodeId,
      nextOriginSeq,
      hlc,
      scope.id,
      row.entry_id,
      canonicalJson([currentStatusRev]),
      rev,
      ctx.clientId,
      input.request_id ?? null,
      hash,
      canonicalJson(payload),
      nowIso(),
    );
    applyEvent(db, { eventId, scopeId: scope.id, entryId: row.entry_id, op: "flag", part: "status", rev, clientId: ctx.clientId, hlc, payload, prev: null });
  })();

  return flagResult(db, row.entry_id, input.ref);
}

function flagResult(db: Database.Database, entryId: string, ref: string): FlagResult {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM flags WHERE entry_id = ?").get(entryId) as { n: number }).n;
  return { ref, status: "flagged", flags: count };
}
