import type Database from "better-sqlite3";
import { applyReplicatedEvent } from "./materialize.js";
import { syncSignalsForScope } from "../journal/sync.js";
import { fieldsFromRow, verifyEventSignature } from "../security/event-signatures.js";

/**
 * Rebuilds materialized state (entries, relations, signals, FTS) from the event log, the
 * source of truth (ADR 0002). Used by `ctxd rebuild` and to recover from a corrupted replica.
 */
export function rebuild(db: Database.Database): void {
  const verificationRows = db.prepare("SELECT * FROM events ORDER BY hlc, event_id").all() as Record<string, unknown>[];
  for (const row of verificationRows) {
    const fields = fieldsFromRow(row);
    verifyEventSignature(db, {
      ...fields,
      payloadHash: row.payload_hash as string | null,
      prevHash: row.prev_hash as string | null,
      signature: row.signature as string | null,
      publicKey: row.public_key as string | null,
    }, Number(row.payload_stripped) !== 1);
  }
  db.transaction(() => {
    // `scopes` is not wiped: `_me`/`_system` are genesis rows with no backing event (SPEC 4's
    // one deliberate exception to "every change is an event"), and a lazily-created `_hold.*`
    // scope (src/store/write.ts) is the same way, so a blanket wipe would permanently lose them.
    // `pools`/`pool_grants`/`pool_members`/`client_grants`/`acl_cursors` have no such exception
    // (every row traces back to an `acl` event, M3 slice 6) and are wiped like everything else,
    // so `ctxd rebuild` actually reconstructs them instead of leaving a corrupted row untouched
    // (found during `/code-review`: without this, aclGuardPasses's own guard against the
    // pre-rebuild cursor made every replayed acl event a no-op).
    // Children before parents (pool_grants/pool_members both reference pools(pool_id), enforced
    // with PRAGMA foreign_keys = ON): deleting pools first would fail while a still-populated
    // child row points at the one being removed.
    db.exec(
      "DELETE FROM relations; DELETE FROM entries; DELETE FROM signals; DELETE FROM flags; DELETE FROM leases; DELETE FROM pool_grants; DELETE FROM pool_members; DELETE FROM pools; DELETE FROM client_grants; DELETE FROM acl_cursors;",
    );

    const events = db.prepare("SELECT * FROM events ORDER BY hlc, event_id").all() as ({
      event_id: string;
      scope_id: string;
      entry_id: string;
      op: string;
      part: string;
      parent_revs: string;
      rev: string;
      client_id: string;
      hlc: string;
      payload: string;
      prev: string | null;
      payload_hash: string | null;
      prev_hash: string | null;
      signature: string | null;
      public_key: string | null;
      payload_stripped: number;
    } & Record<string, unknown>)[];

    const touchedScopes = new Set<string>();
    for (const e of events) {
      const fields = fieldsFromRow(e);
      if (e.part !== "content" && e.part !== "status" && e.part !== "relations" && e.part !== "claim" && e.part !== "meta") continue;
      applyReplicatedEvent(db, {
        eventId: e.event_id,
        scopeId: e.scope_id,
        entryId: e.entry_id,
        op: e.op,
        part: e.part,
        // Only content/update, status/status and claim/release events ever consult parentRevs
        // (Spec 7.4's conflict check); parsing it for every other op/part would be pure waste on
        // a full rebuild. Passed through at all so a rebuild re-derives the same conflict/lww/
        // claim-race resolution live sync apply already made, whatever order these events replay
        // in (SPEC v8 7.4's convergence property, store/materialize.ts's own docstring).
        parentRevs: e.op === "update" || e.op === "status" || e.op === "claim" || e.op === "release" ? (JSON.parse(e.parent_revs) as string[]) : [],
        rev: e.rev,
        clientId: e.client_id,
        hlc: e.hlc,
        payload: JSON.parse(e.payload) as Record<string, unknown>,
        prev: e.prev ? (JSON.parse(e.prev) as Record<string, unknown>) : null,
      }, { skipFts: true });
      touchedScopes.add(e.scope_id);
    }

    db.exec("INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')");
    for (const scopeId of touchedScopes) syncSignalsForScope(db, scopeId);

    // A full, HLC-ordered replay never hits sync/apply.ts's "missing-parent" case (every event's
    // own prior rev always has a smaller hlc, so it has already replayed by the time this one
    // does): whatever `materialized` said before this rebuild, every event is now reflected in
    // materialized state. Left stale, a `materialized = 0` row surviving from before the rebuild
    // would make a later live sync event for the same entry retry (and so double-apply) an event
    // this rebuild already handled (sync/apply.ts's `retryPendingFor`).
    db.exec("UPDATE events SET materialized = 1 WHERE materialized = 0");
  })();
}
