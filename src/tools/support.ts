import type Database from "better-sqlite3";
import { decodeHlc } from "../core/hlc.js";
import { nowIso } from "../core/time.js";
import { importance, type Importance } from "../model/importance.js";
import { accessLevel, atLeast, effectivePools, type ClientInfo, type ScopeInfo } from "../access/level.js";
import { loadAccessSnapshot } from "../store/snapshot.js";
import type { RequestContext } from "../server/context.js";
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

/** ENTRY_COLUMNS, each prefixed with a table alias, for a query that joins `entries` against something else. */
export function entryColumns(alias: string): string {
  return ENTRY_COLUMNS.split(", ")
    .map((c) => `${alias}.${c}`)
    .join(", ");
}

/** The physical-time component of an HLC, as epoch milliseconds (SPEC v6 section 5). */
export function hlcToMs(hlc: string): number {
  return decodeHlc(hlc).physical;
}

/** Importance (SPEC v6 section 11.3), full score plus its four parts, from this entry's real inbound relations and read_stats. Used directly by `ctxd show --why`; entryImportance below is the score-only shortcut every ranking call site actually needs. */
export function entryImportanceDetailed(db: Database.Database, row: EntryRow, nowMs: number): Importance {
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
  });
}

/** Importance (SPEC v6 section 11.3) computed from this entry's real inbound relations and read_stats. */
export function entryImportance(db: Database.Database, row: EntryRow, nowMs: number): number {
  return entryImportanceDetailed(db, row, nowMs).score;
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

export function clientInfoOf(ctx: RequestContext): ClientInfo {
  return { id: ctx.clientId, vendor: ctx.vendor, tags: [] };
}

interface ScopeRow {
  scope_id: string;
  name: string;
  kind: ScopeInfo["kind"];
  owner: string | null;
  vendor_policy: ScopeInfo["vendorPolicy"];
}

export function loadScopeInfos(db: Database.Database): { row: ScopeRow; info: ScopeInfo & { id: string } }[] {
  const rows = db.prepare("SELECT scope_id, name, kind, owner, vendor_policy FROM scopes").all() as ScopeRow[];
  return rows.map((row) => ({
    row,
    info: { id: row.scope_id, kind: row.kind, owner: row.owner ?? undefined, vendorPolicy: row.vendor_policy },
  }));
}

/**
 * The session's working set (SPEC v6 section 10.5): the session scope, the global _me, and the
 * _me.<pool> profiles of the assumed pools. Distinct from access/level.ts's workingSet, which is
 * built for the ctxd mcp launcher's single CTXD_POOL-override persona selection, not for
 * evaluating an already-resolved persona's full set of assumed pools (possibly more than one).
 */
export function sessionWorkingSet(db: Database.Database, ctx: RequestContext, sessionScopeId: string | null): string[] {
  const client = clientInfoOf(ctx);
  const snapshot = loadAccessSnapshot(db);
  const scopes = loadScopeInfos(db);
  const set = new Set<string>();
  for (const { info } of scopes) if (info.kind === "me") set.add(info.id);
  const pools = effectivePools(client, snapshot, ctx.assumedPools);
  for (const { info } of scopes) if (info.kind === "profile" && info.owner && pools.includes(info.owner)) set.add(info.id);
  if (sessionScopeId) {
    const session = scopes.find((s) => s.info.id === sessionScopeId);
    if (session && atLeast(accessLevel(client, session.info, snapshot, Date.now(), ctx.assumedPools), "read")) set.add(sessionScopeId);
  }
  return [...set];
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
