import type Database from "better-sqlite3";
import { accessLevel, atLeast } from "../access/level.js";
import { loadAccessSnapshot } from "../store/snapshot.js";
import { CtxdError } from "../core/errors.js";
import { nowIso } from "../core/time.js";
import { syncFreshness } from "../sync/freshness.js";
import { parseSkill, catalogLine, buildCatalog } from "../skills/skillmd.js";
import { formatRef } from "../model/refs.js";
import {
  entryColumns,
  entryImportance,
  bumpBriefed,
  hlcToMs,
  clientInfoOf,
  clientName,
  loadScopeInfos,
  sessionWorkingSet,
  type EntryRow,
} from "../tools/support.js";
import type { RequestContext } from "../server/context.js";

/**
 * context_brief (SPEC v6 section 11.1): a deterministic, priority-ordered, token-budgeted brief
 * for a scope. Sections are filled in priority order until their own soft cap is spent; lists use
 * each entry's summary line, never its body (bodies are for the pinned brief and handoffs only).
 *
 * Carried forward from earlier milestones, still open:
 * - The brief's own "session" value depends on a session ref reaching this call; nothing between
 *   the hook dispatcher and the MCP tool layer threads one into `RequestContext` yet, so this
 *   stays `null` (not a sync concern, out of scope for M3 slice 7).
 * - Interrupted-work, lost/taken-over claim, overlap and drift notices (SPEC 11.1's Notices row)
 *   are not yet surfaced here; only proposed/conflicted counts and the sync freshness notice
 *   (M3 slice 7, below) are.
 * - Spec gives a concrete total budget (session_start_max_chars, default 9,500) only for the
 *   *hook-injected* brief, not for a plain context_brief tool call. The BASE_CHARS constants below
 *   are this file's own reasonable choice, not a spec number.
 */

export interface BriefInput {
  scope: string;
  size: "micro" | "normal" | "full";
}

const DAY_MS = 86_400_000;
const BASE_CHARS: Record<BriefInput["size"], number> = { micro: 3000, normal: 9500, full: 28_500 };

function cap(base: number, pct: number): number {
  return Math.round((base * pct) / 100);
}

function ageDays(atMs: number, nowMs: number): string {
  const d = Math.floor((nowMs - atMs) / DAY_MS);
  return d < 1 ? "<1d" : `${d}d`;
}

/** Cut a list of lines to a character budget; appends a "(more: ...)" hint when any are left out. */
function fitLines(lines: readonly string[], maxChars: number, moreHint?: string): string[] {
  const { text, omitted } = buildCatalog(lines, maxChars);
  const kept = text ? text.split("\n") : [];
  if (omitted > 0 && moreHint) kept.push(`(more: ${moreHint})`);
  return kept;
}

/** Sort entries so ones past review_after sort last, each marked; otherwise by importance desc. */
function byImportanceReviewLast(db: Database.Database, rows: EntryRow[], now: number): { row: EntryRow; reviewDue: boolean }[] {
  const nowDate = nowIso().slice(0, 10);
  return rows
    .map((row) => ({ row, reviewDue: row.review_after !== null && row.review_after <= nowDate, imp: entryImportance(db, row, now) }))
    .sort((a, b) => (a.reviewDue !== b.reviewDue ? (a.reviewDue ? 1 : -1) : b.imp - a.imp))
    .map(({ row, reviewDue }) => ({ row, reviewDue }));
}

export function assembleBrief(ctx: RequestContext, input: BriefInput): unknown {
  const { db } = ctx;
  const now = Date.now();
  const snapshot = loadAccessSnapshot(db);
  const client = clientInfoOf(ctx);
  const scopes = loadScopeInfos(db);
  const named = scopes.find(({ row }) => row.name === input.scope);
  if (!named) throw new CtxdError("VALIDATION", `Unknown scope "${input.scope}"`, {}, "scope");
  if (!atLeast(accessLevel(client, named.info, snapshot, now, ctx.assumedPools), "read")) {
    throw new CtxdError("SCOPE_FORBIDDEN", `No read access to "${input.scope}"`, {}, "scope");
  }

  const workingIds = sessionWorkingSet(db, ctx, named.row.scope_id);
  const meProfileIds = workingIds.filter((id) => id !== named.row.scope_id);
  const scopeNameById = new Map(scopes.map(({ row }) => [row.scope_id, row.name]));
  const inList = (ids: readonly string[]) => ids.map(() => "?").join(",");

  const base = BASE_CHARS[input.size];
  const micro = input.size === "micro";
  const activeStatuses = input.size === "full" ? "('active','proposed')" : "('active')";
  const briefed: string[] = [];
  const touchBriefed = (id: string): void => {
    briefed.push(id);
  };

  const sections: string[] = [];

  // 2. Notices (section 1, the header, is the scope/as_of/node/sync/session fields returned
  // alongside `brief`, per SPEC v6 8.2's context_brief output shape -- not text in the body).
  const notices: string[] = [];
  const proposedCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE scope_id IN (${inList(workingIds)}) AND status = 'proposed'`).get(
      ...workingIds,
    ) as { n: number }
  ).n;
  if (proposedCount > 0) notices.push(`${proposedCount} proposed entr${proposedCount === 1 ? "y" : "ies"} awaiting review.`);
  const conflictedCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE scope_id IN (${inList(workingIds)}) AND status = 'conflicted'`).get(
      ...workingIds,
    ) as { n: number }
  ).n;
  if (conflictedCount > 0) notices.push(`${conflictedCount} conflicted entr${conflictedCount === 1 ? "y" : "ies"} need resolution.`);
  // Sync freshness (M3 slice 7): same "no successful sync in 10 minutes" rule the tentative-claim
  // check uses (Spec 7.4, src/sync/freshness.ts), surfaced here as SPEC 11.1's "stale sync warning".
  const freshness = syncFreshness(db);
  if (freshness.stale) notices.push("No successful sync in over 10 minutes; this brief may be missing recent changes from other machines.");

  // 3. Open signals (SPEC 11.4)
  const openSignals = db
    .prepare(
      `SELECT s.entry_id, s.scope_id, s.source, s.opened_hlc, e.significance, e.summary
       FROM signals s JOIN entries e ON e.entry_id = s.entry_id
       WHERE s.scope_id IN (${inList(workingIds)}) AND s.resolved_hlc IS NULL
       ORDER BY s.opened_hlc ASC`,
    )
    .all(...workingIds) as {
    entry_id: string;
    scope_id: string;
    source: string;
    opened_hlc: string;
    significance: string | null;
    summary: string;
  }[];
  if (openSignals.length) {
    const shown = openSignals.slice(0, 5).map((s) => {
      const label = s.source === "flag" ? "FLAGGED" : (s.significance ?? s.source).toUpperCase();
      const ref = formatRef(scopeNameById.get(s.scope_id) ?? s.scope_id, s.entry_id);
      return `${label} (${ageDays(hlcToMs(s.opened_hlc), now)}): ${s.summary}, ${ref}`;
    });
    const rest = openSignals.length - shown.length;
    sections.push(["Open signals:", ...shown, ...(rest > 0 ? [`(+${rest} more)`] : [])].join("\n"));
  }

  // 4. Latest status entries
  {
    const rows = db
      .prepare(
        `SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = 'status' AND e.status IN ${activeStatuses}
         ORDER BY e.updated_hlc DESC LIMIT 3`,
      )
      .all(named.row.scope_id) as EntryRow[];
    if (rows.length) {
      const lines = rows.map((r) => `- ${r.summary}${r.status === "proposed" ? " (proposed)" : ""}`);
      rows.forEach((r) => touchBriefed(r.entry_id));
      sections.push(["Latest status:", ...fitLines(lines, cap(base, micro ? 30 : 15), `ctxd://${input.scope}/status/`)].join("\n"));
    }
  }

  // 5. Latest handoff, latest per client
  {
    const rows = db
      .prepare(
        `SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = 'handoff' AND e.status IN ${activeStatuses}
         ORDER BY e.updated_hlc DESC`,
      )
      .all(named.row.scope_id) as EntryRow[];
    const perClient = new Map<string, EntryRow>();
    for (const r of rows) if (!perClient.has(r.updated_by)) perClient.set(r.updated_by, r);
    const take = micro ? 1 : 2;
    const picked = [...perClient.values()].slice(0, take);
    if (picked.length) {
      const lines = picked.map((r) => `- ${clientName(db, r.updated_by)}: ${r.summary}\n${r.body}`);
      picked.forEach((r) => touchBriefed(r.entry_id));
      sections.push(["Latest handoff:", ...fitLines(lines, cap(base, micro ? 40 : 20))].join("\n"));
    }
  }

  // 6. Pinned brief entry (one per scope; overview tier, full body)
  if (!micro) {
    const row = db
      .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = 'brief' AND e.status IN ${activeStatuses} LIMIT 1`)
      .get(named.row.scope_id) as EntryRow | undefined;
    if (row) {
      touchBriefed(row.entry_id);
      const text = `Pinned brief: ${row.title}\n${row.body}`;
      sections.push(trimSection(text, cap(base, 20)));
    }
  }

  // 7. Open claims and ready tasks
  {
    const claims = db
      .prepare(
        `SELECT l.holder, e.title FROM leases l JOIN entries e ON e.entry_id = l.task_id
         WHERE l.scope_id IN (${inList(workingIds)}) AND l.state = 'active' ORDER BY l.claim_hlc ASC LIMIT 5`,
      )
      .all(...workingIds) as { holder: string; title: string }[];
    const tasks = db
      .prepare(
        `SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = 'task' AND e.status IN ${activeStatuses}
         ORDER BY e.updated_hlc DESC LIMIT 5`,
      )
      .all(named.row.scope_id) as EntryRow[];
    const lines: string[] = [
      ...claims.map((c) => `- claimed by ${clientName(db, c.holder)}: ${c.title}`),
      ...tasks.map((t) => (micro ? `- ${t.title}` : `- ${t.summary}`)),
    ];
    tasks.forEach((t) => touchBriefed(t.entry_id));
    if (lines.length) {
      sections.push(["Open claims / ready tasks:", ...fitLines(lines, cap(base, 10))].join("\n"));
    }
  }

  // 8. Active conventions (session scope only; profiles' conventions come in section 10)
  if (!micro) {
    const rows = db
      .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = 'convention' AND e.status IN ${activeStatuses}`)
      .all(named.row.scope_id) as EntryRow[];
    const ranked = byImportanceReviewLast(db, rows, now);
    if (ranked.length) {
      const lines = ranked.map(({ row, reviewDue }) => `- ${row.summary}${reviewDue ? " (review due)" : ""}`);
      ranked.forEach(({ row }) => touchBriefed(row.entry_id));
      sections.push(["Active conventions:", ...fitLines(lines, cap(base, 10), `ctxd://${input.scope}/conventions/`)].join("\n"));
    }
  }

  // 9. Recent decisions (last 30 days)
  if (!micro) {
    const since = now - 30 * DAY_MS;
    const rows = (
      db
        .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = 'decision' AND e.status IN ${activeStatuses}
         ORDER BY e.updated_hlc DESC`)
        .all(named.row.scope_id) as EntryRow[]
    ).filter((r) => hlcToMs(r.updated_hlc) >= since);
    const picked = rows.slice(0, 5);
    if (picked.length) {
      const lines = picked.map((r) => `- ${r.title}: ${r.summary}`);
      picked.forEach((r) => touchBriefed(r.entry_id));
      sections.push(["Recent decisions:", ...fitLines(lines, cap(base, 10), `ctxd://${input.scope}/decisions/`)].join("\n"));
    }
  }

  // 10. Preferences and conventions from global _me and matching pool profiles
  {
    const rows = meProfileIds.length
      ? (db
          .prepare(
            `SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id IN (${inList(meProfileIds)})
             AND e.kind IN ('preference','convention') AND e.status IN ${activeStatuses}`,
          )
          .all(...meProfileIds) as EntryRow[])
      : [];
    const ranked = byImportanceReviewLast(db, rows, now);
    if (ranked.length) {
      const lines = ranked.map(({ row, reviewDue }) => `- ${row.summary}${reviewDue ? " (review due)" : ""}`);
      ranked.forEach(({ row }) => touchBriefed(row.entry_id));
      sections.push(["From your preferences:", ...fitLines(lines, cap(base, micro ? 10 : 5))].join("\n"));
    }
  }

  // 11. Skill catalog
  if (!micro) {
    const rows = db
      .prepare(
        `SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id IN (${inList(workingIds)}) AND e.kind = 'skill' AND e.status IN ${activeStatuses}`,
      )
      .all(...workingIds) as EntryRow[];
    const lines = rows
      .map((r) => {
        try {
          const parsed = parseSkill(r.title, r.body);
          touchBriefed(r.entry_id);
          return catalogLine(parsed, clientName(db, r.created_by));
        } catch {
          return null; // not a well-formed SKILL.md body: leave it out of the catalog rather than fail the brief
        }
      })
      .filter((l): l is string => l !== null);
    if (lines.length) {
      const { text } = buildCatalog(lines, cap(base, 5));
      if (text) sections.push(["Skills:", text].join("\n"));
    }
  }

  // 12. Relevant active lessons: ranked by FTS against the latest status/handoff text
  if (!micro) {
    const seedRows = db
      .prepare(
        `SELECT title, summary FROM entries WHERE scope_id = ? AND kind IN ('status','handoff') AND status = 'active'
         ORDER BY updated_hlc DESC LIMIT 2`,
      )
      .all(named.row.scope_id) as { title: string; summary: string }[];
    const terms = [...new Set(seedRows.flatMap((r) => `${r.title} ${r.summary}`.match(/[a-z0-9]{3,}/gi) ?? []))].slice(0, 8);
    if (terms.length) {
      const query = terms.join(" OR ");
      let lessonRows: EntryRow[] = [];
      try {
        lessonRows = db
          .prepare(
            `SELECT ${entryColumns("e")} FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
             WHERE entries_fts MATCH ? AND e.scope_id = ? AND e.kind = 'lesson' AND e.status = 'active'
             ORDER BY bm25(entries_fts) LIMIT 3`,
          )
          .all(query, named.row.scope_id) as EntryRow[];
      } catch {
        lessonRows = []; // a malformed derived FTS query (e.g. a reserved term): skip this section rather than fail the brief
      }
      if (lessonRows.length) {
        lessonRows.forEach((r) => touchBriefed(r.entry_id));
        sections.push(["Relevant lessons:", ...lessonRows.map((r) => `- ${r.title}`)].join("\n"));
      }
    }
  }

  // 13. Journal highlights (last 7 days)
  if (!micro) {
    const since = now - 7 * DAY_MS;
    const rows = (
      db
        .prepare(
          `SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = 'journal'
           AND e.significance IN ('milestone','breakthrough','incident') AND e.status = 'active' ORDER BY e.created_hlc DESC`,
        )
        .all(named.row.scope_id) as EntryRow[]
    ).filter((r) => hlcToMs(r.created_hlc) >= since);
    const picked = rows.slice(0, 3);
    if (picked.length) {
      picked.forEach((r) => touchBriefed(r.entry_id));
      sections.push(["Journal highlights:", ...picked.map((r) => `- [${r.significance}] ${r.summary}`)].join("\n"));
    }
  }

  for (const id of briefed) bumpBriefed(db, id);
  return {
    scope: input.scope,
    as_of: new Date(now).toISOString(),
    node: ctx.nodeId,
    // null when this node has no peers at all (sync not in use); otherwise the last successful
    // pull from any peer and whether it's stale (M3 slice 7, src/sync/freshness.ts).
    sync: freshness.hasPeers ? { last_synced_at: freshness.lastSyncedAt, stale: freshness.stale } : null,
    // The hook-driven session value (SPEC 9.3) has no path into RequestContext yet; see the
    // file-level comment above.
    session: null,
    brief: sections.join("\n\n"),
    notices,
  };
}

function trimSection(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}
