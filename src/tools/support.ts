import type Database from "better-sqlite3";
import { decodeHlc } from "../core/hlc.js";
import { nowIso } from "../core/time.js";
import { importance } from "../model/importance.js";
import type { Kind, RelationType, Significance, Status } from "../core/kinds.js";

/**
 * Shared, DB-facing helpers for the read tools (context_brief, context_search, context_get):
 * loading entries, computing importance from real relations/read_stats, provenance lines, and
 * read_stats bumps. The pure scoring logic itself stays in model/importance.ts.
 */

export interface EntryRow {
  entry_id: string;
  scope_id: string;
  kind: Kind;
  slug: string;
  significance: Significance | null;
  skill_name: string | null;
  title: string;
  summary: string;
  body: string;
  tags: string;
  content_rev: string;
  content_version: number;
  status: Status;
  status_before: Status | null;
  review_after: string | null;
  purged_at: string | null;
  status_rev: string;
  relations_rev: string;
  supersedes: string | null;
  confirmed_by_user: number;
  created_by: string;
  updated_by: string;
  created_hlc: string;
  updated_hlc: string;
}

export const ENTRY_COLUMNS =
  "entry_id, scope_id, kind, slug, significance, skill_name, title, summary, body, tags, content_rev, content_version, status, status_before, review_after, purged_at, status_rev, relations_rev, supersedes, confirmed_by_user, created_by, updated_by, created_hlc, updated_hlc";

/** The physical-time component of an HLC, as epoch milliseconds (SPEC v6 section 5). */
export function hlcToMs(hlc: string): number {
  return decodeHlc(hlc).physical;
}

/** Importance (SPEC v6 section 11.3) computed from this entry's real inbound relations and read_stats. */
export function entryImportance(db: Database.Database, row: EntryRow, nowMs: number): number {
  const inbound = (
    db.prepare("SELECT type FROM relations WHERE target LIKE ? AND removed_event IS NULL").all(`%/${row.entry_id}`) as {
      type: RelationType;
    }[]
  ).map((r) => r.type);
  const stats = db.prepare("SELECT reads, briefed FROM read_stats WHERE entry_id = ?").get(row.entry_id) as
    | { reads: number; briefed: number }
    | undefined;
  return importance({
    kind: row.kind,
    significance: row.significance,
    inbound,
    updatedAt: hlcToMs(row.updated_hlc),
    now: nowMs,
    reads: stats?.reads ?? 0,
    briefed: stats?.briefed ?? 0,
  }).score;
}

export function bumpRead(db: Database.Database, entryId: string): void {
  db.prepare(
    "INSERT INTO read_stats (entry_id, last_read_at, reads, briefed) VALUES (?, ?, 1, 0) ON CONFLICT (entry_id) DO UPDATE SET last_read_at = excluded.last_read_at, reads = reads + 1",
  ).run(entryId, nowIso());
}

export function bumpBriefed(db: Database.Database, entryId: string): void {
  db.prepare(
    "INSERT INTO read_stats (entry_id, last_read_at, reads, briefed) VALUES (?, ?, 0, 1) ON CONFLICT (entry_id) DO UPDATE SET briefed = briefed + 1",
  ).run(entryId, nowIso());
}

export function clientName(db: Database.Database, clientId: string): string {
  return (db.prepare("SELECT name FROM clients WHERE client_id = ?").get(clientId) as { name: string } | undefined)?.name ?? clientId;
}

export function scopeName(db: Database.Database, scopeId: string): string {
  return (db.prepare("SELECT name FROM scopes WHERE scope_id = ?").get(scopeId) as { name: string } | undefined)?.name ?? scopeId;
}

/** Provenance line (SPEC v6 section 8.2), e.g. "[ctxd:ctxd/01JAB... | decision | proposed | by codex@laptop | 2026-10-16]". */
export function provenanceLine(db: Database.Database, ref: string, row: Pick<EntryRow, "kind" | "status" | "updated_by" | "updated_hlc">): string {
  const date = new Date(hlcToMs(row.updated_hlc)).toISOString().slice(0, 10);
  return `[${ref} | ${row.kind} | ${row.status} | by ${clientName(db, row.updated_by)} | ${date}]`;
}
