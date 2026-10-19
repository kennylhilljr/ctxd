/**
 * Weekly digest (SPEC v8 11.5): assembled without a model, from entries, signals and auto
 * journal tags created, approved or resolved in the digest node's local ISO week. Written as a
 * `journal` entry, significance `routine`, tags `digest` and the week id. Idempotent per
 * (scope, week) via `digestRequestId`: callers check `digestAlreadyWritten` first and skip the
 * write entirely for a week already covered, rather than relying on writeEntry's request-hash
 * check, since a still-open week's content can change between calls and would otherwise risk an
 * IDEMPOTENCY_MISMATCH on a harmless re-run.
 */
import type Database from "better-sqlite3";
import { decodeHlc } from "../core/hlc.js";
import { isoWeekBounds, localWeekdayAndHour } from "../core/dates.js";
import { buildCatalog } from "../skills/skillmd.js";
import { writeEntry, type WriteContext } from "../store/write.js";
import { CtxdError } from "../core/errors.js";
import { digestRequestId, isoWeek } from "./time.js";
import type { Kind, Significance } from "../core/kinds.js";
import type { CtxdConfig } from "../config/config.js";

const BODY_MAX = 1000;
const SECTION_MAX = 120;

interface EntryRow {
  entry_id: string;
  kind: Kind;
  significance: Significance | null;
  title: string;
  tags: string;
  created_hlc: string;
  updated_hlc: string;
}

function within(hlc: string | null, from: number, to: number): boolean {
  return hlc !== null && decodeHlc(hlc).physical >= from && decodeHlc(hlc).physical < to;
}

function section(label: string, lines: string[], folderPath: string): string | null {
  if (lines.length === 0) return null;
  const { text, omitted } = buildCatalog(lines, SECTION_MAX);
  return `${label}:\n${text}${omitted > 0 ? `\n(more: ${folderPath})` : ""}`;
}

export interface DigestContent {
  body: string;
  empty: boolean;
}

/** Assembles one scope's digest body for the ISO week `weekId` (SPEC 11.5's "Contents" list). */
export function assembleDigest(db: Database.Database, scopeId: string, scopeName: string, weekId: string, timeZone?: string): DigestContent {
  const { from, to } = isoWeekBounds(weekId, timeZone);

  const entries = db
    .prepare("SELECT entry_id, kind, significance, title, tags, created_hlc, updated_hlc FROM entries WHERE scope_id = ? AND status = 'active'")
    .all(scopeId) as EntryRow[];
  const createdThisWeek = entries.filter((e) => within(e.created_hlc, from, to));

  const counts = new Map<string, number>();
  for (const e of createdThisWeek) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const countLines = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`);

  const milestoneLines = createdThisWeek
    .filter((e) => e.kind === "journal" && (e.significance === "milestone" || e.significance === "breakthrough"))
    .map((e) => `${e.significance}: ${e.title}`);

  // "Decisions made": entries.approved_hlc/approved_by exist in the schema but nothing in the
  // write or review path ever sets them, so updated_hlc (which review-approval genuinely does
  // update when a proposed decision becomes active) is the best available signal for "made."
  const decisionLines = entries.filter((e) => e.kind === "decision" && within(e.updated_hlc, from, to)).map((e) => e.title);

  const addedLines = createdThisWeek
    .filter((e) => e.kind === "lesson" || e.kind === "preference" || e.kind === "skill")
    .map((e) => `${e.kind}: ${e.title}`);

  const autoEntries = createdThisWeek.filter((e) => e.kind === "journal" && (JSON.parse(e.tags) as string[]).includes("auto"));
  const commitIds = autoEntries.length
    ? new Set(
        (
          db
            .prepare(
              `SELECT entry_id FROM relations WHERE type = 'points_to' AND target LIKE 'commit:%' AND removed_event IS NULL
               AND entry_id IN (${autoEntries.map(() => "?").join(",")})`,
            )
            .all(...autoEntries.map((e) => e.entry_id)) as { entry_id: string }[]
        ).map((r) => r.entry_id),
      )
    : new Set<string>();
  const commitCount = autoEntries.filter((e) => commitIds.has(e.entry_id)).length;
  const sessionCount = autoEntries.length - commitCount;

  const signalRows = db
    .prepare(
      `SELECT s.opened_hlc, s.resolved_hlc, e.title, e.significance FROM signals s JOIN entries e ON e.entry_id = s.entry_id
       WHERE s.scope_id = ? AND s.source = 'journal'`,
    )
    .all(scopeId) as { opened_hlc: string; resolved_hlc: string | null; title: string; significance: Significance | null }[];
  const signalLines = [
    ...signalRows.filter((s) => within(s.opened_hlc, from, to)).map((s) => `opened ${s.significance ?? "blocker"}: ${s.title}`),
    ...signalRows
      .filter((s) => within(s.resolved_hlc, from, to))
      .map((s) => {
        const hours = Math.round((decodeHlc(s.resolved_hlc as string).physical - decodeHlc(s.opened_hlc).physical) / 3_600_000);
        return `resolved (${hours}h): ${s.title}`;
      }),
  ];

  const sections = [
    section("New this week", countLines, `ctxd://${scopeName}/`),
    section("Milestones and breakthroughs", milestoneLines, `ctxd://${scopeName}/journal/`),
    section("Blockers and incidents", signalLines, `ctxd://${scopeName}/journal/`),
    section("Decisions made", decisionLines, `ctxd://${scopeName}/decisions/`),
    section("Added", addedLines, `ctxd://${scopeName}/`),
    sessionCount + commitCount > 0 ? `Auto: ${sessionCount} session(s), ${commitCount} commit(s)` : null,
  ].filter((s): s is string => s !== null);

  if (sections.length === 0) return { body: "No new activity this week.", empty: true };
  // SECTION_MAX bounds each section, but a long scope name in every folder-path hint at once
  // could still push the total over BODY_MAX: drop whole sections from the end until it fits.
  while (sections.join("\n\n").length > BODY_MAX && sections.length > 1) sections.pop();
  return { body: sections.join("\n\n"), empty: false };
}

/** Whether a digest for (scope, weekId) was already written by `clientId`; checked before assembling, so a still-open week's changing content never risks an idempotency mismatch. */
export function digestAlreadyWritten(db: Database.Database, clientId: string, scopeId: string, weekId: string, timeZone?: string): boolean {
  const { from } = isoWeekBounds(weekId, timeZone);
  const requestId = digestRequestId(scopeId, from, timeZone);
  return db.prepare("SELECT 1 FROM events WHERE client_id = ? AND request_id = ?").get(clientId, requestId) !== undefined;
}

/** Scopes with at least one event in [from, to), the digest's "at least one new event that week" gate (SPEC 11.5). */
export function scopesWithActivity(db: Database.Database, from: number, to: number): { id: string; name: string }[] {
  const scopes = db.prepare("SELECT scope_id AS id, name FROM scopes").all() as { id: string; name: string }[];
  return scopes.filter((s) => {
    const rows = db.prepare("SELECT hlc FROM events WHERE scope_id = ?").all(s.id) as { hlc: string }[];
    return rows.some((r) => within(r.hlc, from, to));
  });
}

/** The most recently completed ISO week as of `now`, always fully closed (its `to` bound is at or before `now`). */
export function lastCompletedWeek(now: number, timeZone?: string): string {
  return isoWeek(now - 7 * 86_400_000, timeZone);
}

/**
 * Assembles and writes the digest for (scope, weekId), returning the body it wrote. Callers
 * check `digestAlreadyWritten` first; the body is returned rather than left for the caller to
 * recompute, since assembling it again afterward would count the just-written entry itself.
 */
export function writeDigest(ctx: WriteContext, scopeId: string, scopeName: string, weekId: string, timeZone?: string): { ref: string; body: string } {
  const { body } = assembleDigest(ctx.db, scopeId, scopeName, weekId, timeZone);
  const { from } = isoWeekBounds(weekId, timeZone);
  const result = writeEntry(ctx, {
    scope: scopeName,
    kind: "journal",
    title: `Weekly digest: ${weekId}`,
    body,
    significance: "routine",
    tags: ["digest", weekId],
    request_id: digestRequestId(scopeId, from, timeZone),
  } as never);
  if ("held" in result) {
    // Unreachable for the human client (SPEC v6 section 6 step 1: human writes are always
    // "write"), kept only so a future access-model change fails loudly instead of silently.
    throw new CtxdError("NOT_ALLOWED", result.message);
  }
  return { ref: result.ref, body };
}

/**
 * The automatic trigger (SPEC 11.5): only `journal.digest_node` runs this, on
 * `journal.digest_weekday` after 18:00 local, for each scope with new activity that week not
 * yet digested. Safe to call on every server tick and again at startup (the offline-catch-up
 * case): `digestAlreadyWritten` makes every call but the first a no-op.
 */
export function runDueDigests(ctx: WriteContext, config: CtxdConfig, now: number, timeZone?: string): void {
  if (!config.journal.digest_node || config.journal.digest_node !== config.node.name) return;
  const { weekday, hour } = localWeekdayAndHour(now, timeZone);
  if (weekday !== config.journal.digest_weekday || hour < 18) return;

  const weekId = isoWeek(now, timeZone);
  const { from, to } = isoWeekBounds(weekId, timeZone);
  for (const scope of scopesWithActivity(ctx.db, from, to)) {
    if (!digestAlreadyWritten(ctx.db, ctx.clientId, scope.id, weekId, timeZone)) writeDigest(ctx, scope.id, scope.name, weekId, timeZone);
  }
}
