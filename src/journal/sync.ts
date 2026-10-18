import type Database from "better-sqlite3";
import { parseRef } from "../model/refs.js";
import { computeSignals, type SignalEntry, type SignalFlag, type SignalRelation } from "./signals.js";
import type { Kind, Significance, Status } from "../core/kinds.js";

/**
 * Materializes the `signals` table for one scope from its current entries, relations and flags
 * (SPEC v6 section 11.4), so every node derives the same rows from the same events.
 *
 * M1 scope: only the active/proposed/flagged/superseded statuses reachable this milestone are
 * modeled (quarantine, archive and rollback are M2). Resolution is scope-local: a `resolved`
 * link from an entry in a *different* scope than its target is not counted here (flagged for
 * SPEC-v7 — most real usage resolves within the same scope).
 */

interface EntryRow {
  entry_id: string;
  kind: Kind;
  significance: Significance | null;
  status: Status;
  status_before: Status | null;
  created_hlc: string;
  updated_hlc: string;
  purged_at: string | null;
}

const RETIRED: ReadonlySet<Status> = new Set(["superseded", "archived", "quarantined", "deleted"]);

function toSignalEntry(row: EntryRow, scopeId: string): SignalEntry {
  const activeHlc =
    row.status === "active"
      ? row.created_hlc
      // superseded only became live if it was active beforehand, same as flagged.
      : row.status === "flagged" || row.status === "superseded"
        ? row.status_before === "active"
          ? row.created_hlc
          : null
        : row.status === "proposed"
          ? null
          : row.created_hlc; // quarantined/archived/conflicted/deleted: not reachable in M1
  const retiredHlc = RETIRED.has(row.status) || row.purged_at !== null ? row.updated_hlc : null;
  return { id: row.entry_id, scope: scopeId, kind: row.kind, significance: row.significance, activeHlc, retiredHlc };
}

export function syncSignalsForScope(db: Database.Database, scopeId: string): void {
  const entryRows = db
    .prepare(
      "SELECT entry_id, kind, significance, status, status_before, created_hlc, updated_hlc, purged_at FROM entries WHERE scope_id = ?",
    )
    .all(scopeId) as EntryRow[];
  const entries = entryRows.map((r) => toSignalEntry(r, scopeId));
  const entryIds = entryRows.map((r) => r.entry_id);
  const entryById = new Map(entryRows.map((r) => [r.entry_id, r]));

  const relations: SignalRelation[] = entryIds.length
    ? (
        db
          .prepare(
            `SELECT r.entry_id AS source, r.type AS type, r.target AS target, e1.hlc AS addedHlc,
                    (SELECT hlc FROM events WHERE event_id = r.removed_event) AS removedHlc
             FROM relations r JOIN events e1 ON e1.event_id = r.added_event
             WHERE r.type IN ('resolved', 'blocks') AND r.entry_id IN (${entryIds.map(() => "?").join(",")})`,
          )
          .all(...entryIds) as { source: string; type: string; target: string; addedHlc: string; removedHlc: string | null }[]
      ).flatMap((r) => {
        const target = parseRef(r.target)?.id;
        return target ? [{ source: r.source, type: r.type, target, addedHlc: r.addedHlc, removedHlc: r.removedHlc }] : [];
      })
    : [];

  const flags: SignalFlag[] = entryIds.length
    ? (
        db
          .prepare(
            `SELECT entry_id, flagged_hlc, resolved FROM flags WHERE entry_id IN (${entryIds.map(() => "?").join(",")})`,
          )
          .all(...entryIds) as { entry_id: string; flagged_hlc: string; resolved: string | null }[]
      ).map((f) => {
        const entry = entryById.get(f.entry_id);
        return { entry: f.entry_id, flaggedHlc: f.flagged_hlc, resolvedHlc: f.resolved !== null ? entry?.updated_hlc ?? null : null };
      })
    : [];

  const signals = computeSignals(entries, relations, flags);

  const current = db.prepare("SELECT entry_id, source FROM signals WHERE scope_id = ?").all(scopeId) as {
    entry_id: string;
    source: string;
  }[];
  const wanted = new Set(signals.map((s) => `${s.entryId}\u0000${s.source}`));
  for (const row of current) {
    if (!wanted.has(`${row.entry_id}\u0000${row.source}`)) {
      db.prepare("DELETE FROM signals WHERE entry_id = ? AND source = ?").run(row.entry_id, row.source);
    }
  }
  const upsert = db.prepare(
    `INSERT INTO signals (entry_id, scope_id, source, opened_hlc, resolved_hlc, resolved_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (entry_id, source) DO UPDATE SET opened_hlc = excluded.opened_hlc, resolved_hlc = excluded.resolved_hlc, resolved_by = excluded.resolved_by`,
  );
  for (const s of signals) {
    upsert.run(s.entryId, s.scope, s.source, s.openedHlc, s.resolvedHlc, s.resolvedBy);
  }
}
