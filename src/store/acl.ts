import { makeRev, newId } from "../core/ids.js";
import { SYSTEM_SCOPE_ID } from "../core/kinds.js";
import { nowIso } from "../core/time.js";
import { canonicalJson } from "./idempotency.js";
import { applyEvent } from "./materialize.js";
import { nextOriginSeq, type WriteContext } from "./write.js";

/**
 * Appends and applies one `acl` event (SPEC v8 4): access metadata (scope/pool creation, grants,
 * membership, review policy) travels as events in the reserved `_system` scope instead of a
 * direct table write, so it replicates like everything else. Shared by src/cli/grant.ts,
 * src/cli/pool.ts, src/cli/scope.ts and src/store/review.ts, found duplicated four times during
 * `/simplify`. `entryId` is the entity's own id (a pool, a scope, a client), not a knowledge
 * entry; `src/store/materialize.ts`'s `applyAclEvent` is the single place that reads `payload`.
 */
export function appendAclEvent(ctx: WriteContext, entryId: string, payload: Record<string, unknown>): void {
  const { db } = ctx;
  const eventId = newId();
  const hlc = ctx.clock.tick();
  const rev = makeRev(1, eventId);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'acl', 'meta', '[]', ?, ?, NULL, NULL, NULL, ?, NULL, ?)`,
    ).run(eventId, ctx.nodeId, nextOriginSeq(db, ctx.nodeId), hlc, SYSTEM_SCOPE_ID, entryId, rev, ctx.clientId, canonicalJson(payload), nowIso());
    applyEvent(db, { eventId, scopeId: SYSTEM_SCOPE_ID, entryId, op: "acl", part: "meta", rev, clientId: ctx.clientId, hlc, payload, prev: null });
  })();
}
