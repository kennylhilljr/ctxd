/**
 * `ctxd tidy` (SPEC v8 7.6.7, PRD-context-hygiene-v1 section 7): one finding per candidate,
 * applied only once I confirm, as ordinary events. Never changes anything on its own.
 *
 * Five kinds of findings, mapped onto the four actions SPEC 7.6.7 names:
 * - superseded entries older than 90 days -> archive
 * - low-importance, old, long-unread entries (SPEC 11.3's own archive threshold: importance
 *   below 0.15, older than 180 days, unread for 90) -> archive
 * - entries past their review_after date -> review (applying snoozes it another default period)
 * - likely duplicates by title similarity -> merge (never auto-applied: deciding which entry's
 *   content wins is an editorial call this never makes for me)
 * - flags open longer than a week -> close a flag (applying unflags, reusing flag.ts's own
 *   unflagEntry rather than duplicating its restore-status logic)
 */
import type Database from "better-sqlite3";
import { allocateOriginSeq } from "./origin-seq.js";
import { newId, makeRev, revVersion } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { CtxdError } from "../core/errors.js";
import { canonicalJson } from "./idempotency.js";
import { formatRef, parseRef } from "../model/refs.js";
import { applyEvent } from "./materialize.js";
import { loadClient } from "./snapshot.js";
import { unflagEntry } from "./flag.js";
import { entryColumns, entryImportance, hlcToMs, type EntryRow } from "../tools/support.js";
import type { WriteContext } from "./write.js";
import { signStoredEvent } from "../security/event-signatures.js";

const DAY_MS = 86_400_000;
const SUPERSEDED_ARCHIVE_DAYS = 90;
const STALE_ARCHIVE_AGE_DAYS = 180;
const STALE_ARCHIVE_UNREAD_DAYS = 90;
const STALE_ARCHIVE_IMPORTANCE = 0.15;
const DUPLICATE_TITLE_SIMILARITY = 0.8;
const STALE_FLAG_DAYS = 7;

export type TidyKind = "archive-superseded" | "archive-stale" | "review-due" | "duplicate" | "stale-flag";

export interface TidyFinding {
  kind: TidyKind;
  ref: string;
  /** The other half of a duplicate pair. */
  other?: string;
  reason: string;
}

type Row = EntryRow & { scope_name: string };

/** `extraArgs` bind to `?` placeholders in `where`, in order, before the scope filter's own. */
function loadRows(db: Database.Database, where: string, scopeId: string | undefined, extraArgs: readonly unknown[] = []): Row[] {
  const scopeFilter = scopeId ? `AND e.scope_id = ?` : "";
  const args = scopeId ? [...extraArgs, scopeId] : [...extraArgs];
  return db
    .prepare(`SELECT ${entryColumns("e")}, s.name AS scope_name FROM entries e JOIN scopes s ON s.scope_id = e.scope_id WHERE ${where} ${scopeFilter}`)
    .all(...args) as Row[];
}

/** Jaccard similarity over lowercase word sets; a simple, explainable heuristic, not a model. */
function titleSimilarity(a: string, b: string): number {
  const wordsOf = (s: string): Set<string> => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsA = wordsOf(a);
  const wordsB = wordsOf(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

function findSupersededToArchive(db: Database.Database, scopeId: string | undefined, now: number): TidyFinding[] {
  return loadRows(db, "e.status = 'superseded'", scopeId)
    .map((row) => ({ row, ageDays: (now - hlcToMs(row.updated_hlc)) / DAY_MS }))
    .filter(({ ageDays }) => ageDays > SUPERSEDED_ARCHIVE_DAYS)
    .map(({ row, ageDays }) => ({
      kind: "archive-superseded" as const,
      ref: formatRef(row.scope_name, row.entry_id),
      reason: `superseded ${Math.round(ageDays)} days ago`,
    }));
}

function findStaleToArchive(db: Database.Database, scopeId: string | undefined, now: number): TidyFinding[] {
  const findings: TidyFinding[] = [];
  for (const row of loadRows(db, "e.status = 'active'", scopeId)) {
    const ageDays = (now - hlcToMs(row.updated_hlc)) / DAY_MS;
    if (ageDays <= STALE_ARCHIVE_AGE_DAYS) continue;
    const stats = db.prepare("SELECT last_read_at FROM read_stats WHERE entry_id = ?").get(row.entry_id) as { last_read_at: string } | undefined;
    const unreadDays = stats ? (now - Date.parse(stats.last_read_at)) / DAY_MS : Infinity;
    if (unreadDays <= STALE_ARCHIVE_UNREAD_DAYS) continue;
    const importance = entryImportance(db, row, now);
    if (importance >= STALE_ARCHIVE_IMPORTANCE) continue;
    const unreadText = unreadDays === Infinity ? "never read" : `unread ${Math.round(unreadDays)} days`;
    findings.push({
      kind: "archive-stale",
      ref: formatRef(row.scope_name, row.entry_id),
      reason: `importance ${importance.toFixed(2)}, ${Math.round(ageDays)} days old, ${unreadText}`,
    });
  }
  return findings;
}

function findReviewDue(db: Database.Database, scopeId: string | undefined): TidyFinding[] {
  const today = nowIso().slice(0, 10);
  return loadRows(
    db,
    "e.review_after IS NOT NULL AND e.review_after <= ? AND e.status NOT IN ('archived','deleted','superseded','quarantined')",
    scopeId,
    [today],
  ).map((row) => ({ kind: "review-due" as const, ref: formatRef(row.scope_name, row.entry_id), reason: `review-by date ${row.review_after} has passed` }));
}

function findDuplicates(db: Database.Database, scopeId: string | undefined): TidyFinding[] {
  const groups = new Map<string, Row[]>();
  for (const row of loadRows(db, "e.status = 'active'", scopeId)) {
    const key = `${row.scope_id}:${row.kind}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const findings: TidyFinding[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const similarity = titleSimilarity(group[i]!.title, group[j]!.title);
        if (similarity < DUPLICATE_TITLE_SIMILARITY) continue;
        findings.push({
          kind: "duplicate",
          ref: formatRef(group[i]!.scope_name, group[i]!.entry_id),
          other: formatRef(group[j]!.scope_name, group[j]!.entry_id),
          reason: `title similarity ${similarity.toFixed(2)}`,
        });
      }
    }
  }
  return findings;
}

function findStaleFlags(db: Database.Database, scopeId: string | undefined, now: number): TidyFinding[] {
  const scopeFilter = scopeId ? "AND e.scope_id = ?" : "";
  const args = scopeId ? [scopeId] : [];
  const rows = db
    .prepare(
      `SELECT f.flagged_hlc, e.entry_id, s.name AS scope_name FROM flags f
       JOIN entries e ON e.entry_id = f.entry_id JOIN scopes s ON s.scope_id = e.scope_id
       WHERE f.resolved IS NULL ${scopeFilter}`,
    )
    .all(...args) as { flagged_hlc: string; entry_id: string; scope_name: string }[];
  return rows
    .map((row) => ({ row, ageDays: (now - hlcToMs(row.flagged_hlc)) / DAY_MS }))
    .filter(({ ageDays }) => ageDays > STALE_FLAG_DAYS)
    .map(({ row, ageDays }) => ({
      kind: "stale-flag" as const,
      ref: formatRef(row.scope_name, row.entry_id),
      reason: `flagged ${Math.round(ageDays)} days ago, still open`,
    }));
}

/** Read-only: every current finding, across every scope the caller has already read (filter by scopeId if given). Never changes anything. */
export function findTidyCandidates(db: Database.Database, scopeId?: string): TidyFinding[] {
  const now = Date.now();
  return [
    ...findSupersededToArchive(db, scopeId, now),
    ...findStaleToArchive(db, scopeId, now),
    ...findReviewDue(db, scopeId),
    ...findDuplicates(db, scopeId),
    ...findStaleFlags(db, scopeId, now),
  ];
}

interface ResolvedEntry {
  entry_id: string;
  scope_id: string;
  status: string;
  status_rev: string;
  kind: string;
}

function resolveEntryRow(db: Database.Database, ref: string): ResolvedEntry {
  const parsed = parseRef(ref);
  const id = parsed ? parsed.id : ref;
  const row = db.prepare("SELECT entry_id, scope_id, status, status_rev, kind FROM entries WHERE entry_id = ?").get(id) as ResolvedEntry | undefined;
  if (!row) throw new CtxdError("NOT_FOUND", `Entry not found: ${ref}`, {}, "ref");
  return row;
}

/** A standalone status-change event, outside writeEntry's own transaction (SPEC 7.6.7 applies tidy actions "as ordinary events"). */
export function setEntryStatus(ctx: WriteContext, ref: string, newStatus: string): void {
  const { db } = ctx;
  const row = resolveEntryRow(db, ref);
  const eventId = newId();
  const hlc = ctx.clock.tick();
  const rev = makeRev(revVersion(row.status_rev) + 1, eventId);
  const payload = { status: newStatus };
  const prev = { status: row.status };
  const nextSeq = allocateOriginSeq(db, ctx.nodeId);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'status', 'status', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(eventId, ctx.nodeId, nextSeq, hlc, row.scope_id, row.entry_id, canonicalJson([row.status_rev]), rev, ctx.clientId, canonicalJson(payload), canonicalJson(prev), nowIso());
    signStoredEvent(db, eventId, ctx.flags);
    applyEvent(db, { eventId, scopeId: row.scope_id, entryId: row.entry_id, op: "status", part: "status", rev, clientId: ctx.clientId, hlc, payload, prev });
  })();
}

/** Pushes review_after forward by this entry's own default period again, i.e. "I reviewed it, remind me later." A kind with no default cannot reach a review-due finding in the first place. */
function snoozeReview(ctx: WriteContext, ref: string, days: number): void {
  const { db } = ctx;
  const row = resolveEntryRow(db, ref);
  const nextReviewAfter = new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
  db.prepare("UPDATE entries SET review_after = ? WHERE entry_id = ?").run(nextReviewAfter, row.entry_id);
}

const REVIEW_SNOOZE_DAYS_BY_KIND: Readonly<Record<string, number>> = {
  status: 14,
  handoff: 30,
  fact: 180,
  lesson: 180,
  preference: 365,
};

export interface TidyApplyResult {
  ref: string;
  action: string;
}

/** Applies exactly one finding, human only (SPEC's access table: review-adjacent actions are human only). Never applies a duplicate finding: deciding which side wins is an editorial call this makes for me, not without me. */
export function applyTidyFinding(ctx: WriteContext, finding: TidyFinding): TidyApplyResult {
  const client = loadClient(ctx.db, ctx.clientId);
  if (!client || client.vendor !== "human") throw new CtxdError("NOT_ALLOWED", "ctxd tidy --apply is human only");

  switch (finding.kind) {
    case "archive-superseded":
    case "archive-stale":
      setEntryStatus(ctx, finding.ref, "archived");
      return { ref: finding.ref, action: "archived" };
    case "review-due": {
      const row = resolveEntryRow(ctx.db, finding.ref);
      const days = REVIEW_SNOOZE_DAYS_BY_KIND[row.kind] ?? 90;
      snoozeReview(ctx, finding.ref, days);
      return { ref: finding.ref, action: `review snoozed ${days} more days` };
    }
    case "stale-flag": {
      const result = unflagEntry(ctx, finding.ref);
      return { ref: finding.ref, action: `unflagged (${result.flags_closed} closed)` };
    }
    case "duplicate":
      throw new CtxdError(
        "VALIDATION",
        `Duplicate suggestions are never auto-applied: decide by hand which of ${finding.ref} and ${finding.other} to keep, then supersede or archive the other`,
        {},
        "ref",
      );
  }
}
