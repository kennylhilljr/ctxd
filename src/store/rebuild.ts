import type Database from "better-sqlite3";
import { applyReplicatedEvent } from "./materialize.js";
import { syncSignalsForScope } from "../journal/sync.js";

/**
 * Rebuilds materialized state (entries, relations, signals, FTS) from the event log, the
 * source of truth (ADR 0002). Used by `ctxd rebuild` and to recover from a corrupted replica.
 */
export function rebuild(db: Database.Database): void {
  db.transaction(() => {
    db.exec("DELETE FROM relations; DELETE FROM entries; DELETE FROM signals; DELETE FROM flags; DELETE FROM leases;");

    const events = db.prepare("SELECT * FROM events ORDER BY hlc, event_id").all() as {
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
    }[];

    const touchedScopes = new Set<string>();
    for (const e of events) {
      if (e.part !== "content" && e.part !== "status" && e.part !== "relations" && e.part !== "claim" && e.part !== "meta") continue;
      applyReplicatedEvent(db, {
        eventId: e.event_id,
        scopeId: e.scope_id,
        entryId: e.entry_id,
        op: e.op,
        part: e.part,
        // Only content/update and status/status events ever consult parentRevs (Spec 7.4's
        // conflict check); parsing it for every other op/part would be pure waste on a full
        // rebuild. Passed through at all so a rebuild re-derives the same conflict/lww
        // resolution live sync apply already made, whatever order these events replay in (SPEC
        // v8 7.4's convergence property, store/materialize.ts's own docstring).
        parentRevs: e.op === "update" || e.op === "status" ? (JSON.parse(e.parent_revs) as string[]) : [],
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
  })();
}
