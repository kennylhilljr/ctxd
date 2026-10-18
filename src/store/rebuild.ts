import type Database from "better-sqlite3";
import { applyEvent } from "./materialize.js";
import { syncSignalsForScope } from "../journal/sync.js";

/**
 * Rebuilds materialized state (entries, relations, signals, FTS) from the event log, the
 * source of truth (ADR 0002). Used by `ctxd rebuild` and to recover from a corrupted replica.
 */
export function rebuild(db: Database.Database): void {
  db.transaction(() => {
    db.exec("DELETE FROM relations; DELETE FROM entries; DELETE FROM signals;");

    const events = db.prepare("SELECT * FROM events ORDER BY hlc, event_id").all() as {
      event_id: string;
      scope_id: string;
      entry_id: string;
      op: string;
      part: string;
      rev: string;
      client_id: string;
      hlc: string;
      payload: string;
      prev: string | null;
    }[];

    const touchedScopes = new Set<string>();
    for (const e of events) {
      if (e.part !== "content" && e.part !== "status" && e.part !== "relations") continue; // other parts land with their own M1/M2 slices
      applyEvent(db, {
        eventId: e.event_id,
        scopeId: e.scope_id,
        entryId: e.entry_id,
        op: e.op,
        part: e.part,
        rev: e.rev,
        clientId: e.client_id,
        hlc: e.hlc,
        payload: JSON.parse(e.payload) as Record<string, unknown>,
        prev: e.prev ? (JSON.parse(e.prev) as Record<string, unknown>) : null,
      });
      touchedScopes.add(e.scope_id);
    }

    db.exec("INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')");
    for (const scopeId of touchedScopes) syncSignalsForScope(db, scopeId);
  })();
}
