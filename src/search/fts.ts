import type Database from "better-sqlite3";
import { accessLevel, atLeast, type AccessSnapshot, type ScopeInfo } from "../access/level.js";
import { loadAccessSnapshot } from "../store/snapshot.js";
import { isFlagOn } from "../config/flags.js";
import type { Kind, Status } from "../core/kinds.js";
import {
  hlcToMs,
  entryImportance,
  clientInfoOf,
  clientName,
  loadScopeInfos,
  sessionWorkingSet,
  entryColumns,
  type EntryRow,
} from "../tools/support.js";
import { timeWindow } from "../journal/time.js";
import { entryPath, isUnder, parsePath } from "../fsview/paths.js";
import { formatRef } from "../model/refs.js";
import { CtxdError } from "../core/errors.js";
import { score } from "./rank.js";
import type { RequestContext } from "../server/context.js";
import { isModelCached, loadEmbedder } from "../embed/model.js";
import { vecSearch } from "../embed/vec.js";

/**
 * Full-text search (SPEC v6 section 11.2): FTS5 bm25 blended with importance, path/since/until
 * filters, scope fan-out with the 0.9/0.8 multipliers, and the flag/proposed/skill visibility
 * rules. `query: "*"` lists by time instead of relevance.
 */

export interface SearchInput {
  scope?: string;
  query: string;
  path?: string;
  kinds?: Kind[];
  since?: string;
  until?: string;
  limit: number;
  max_tokens: number;
  include_proposed: boolean;
}

export interface SearchResultRow {
  ref: string;
  path: string;
  scope: string;
  kind: Kind;
  title: string;
  summary: string;
  status: Status;
  rev: string;
  by: string;
  updated: string;
  snippet: string;
  significance?: string;
}

const EXCLUDED_STATUSES: ReadonlySet<Status> = new Set(["superseded", "archived", "deleted", "quarantined"]);

interface ScopeCandidate {
  id: string;
  name: string;
  kind: ScopeInfo["kind"];
  multiplier: number;
}

/**
 * Scopes to search and each one's score multiplier (SPEC v6 11.2): with scope "*", every
 * readable scope (_me/profile at 0.9, everything else at 0.8 -- there is no single "home" scope
 * to distinguish in this mode, flagged for SPEC-v7); otherwise the named scope at 1.0 plus the
 * rest of the session's working set (SPEC 10.5) at 0.9.
 */
function candidateScopes(
  db: Database.Database,
  ctx: RequestContext,
  snapshot: AccessSnapshot,
  scopeName: string | undefined,
): ScopeCandidate[] {
  const client = clientInfoOf(ctx);
  const scopes = loadScopeInfos(db);

  if (scopeName === "*") {
    return scopes
      .filter(({ info }) => atLeast(accessLevel(client, info, snapshot, Date.now(), ctx.assumedPools), "read"))
      .map(({ row }) => ({ id: row.scope_id, name: row.name, kind: row.kind, multiplier: row.kind === "me" || row.kind === "profile" ? 0.9 : 0.8 }));
  }

  const named = scopes.find(({ row }) => row.name === scopeName);
  if (!named) return [];
  if (!atLeast(accessLevel(client, named.info, snapshot, Date.now(), ctx.assumedPools), "read")) return [];

  const workingIds = sessionWorkingSet(db, ctx, named.row.scope_id);
  return workingIds.map((id) => {
    const found = scopes.find(({ row }) => row.scope_id === id)!;
    return { id, name: found.row.name, kind: found.row.kind, multiplier: id === named.row.scope_id ? 1.0 : 0.9 };
  });
}

/** The scope segment of a ctxd:// folder path, for a `path` filter given without a `scope`. */
function scopeOfPath(path: string): string {
  const parsed = parsePath(path);
  if ("scope" in parsed) return parsed.scope;
  throw new CtxdError("VALIDATION", "path must be inside a scope", {}, "path");
}

/**
 * FTS5's query string is a small expression language of its own (`-`, `"`, `(`, `)`, `*`, `:`,
 * `OR`/`AND`/`NOT`...), so passing free text straight to MATCH throws a raw SqliteError the
 * moment a query contains one of those characters -- found via a real query, "blue-green
 * deployment rollback", while building the W6 search benchmark's fixtures. Wrapping each
 * whitespace-separated word in its own quoted phrase (doubling any literal `"` inside it, FTS5's
 * own escape for a quote within a quoted string) makes every word literal, keeping the same
 * implicit-AND-of-terms behavior for an ordinary query.
 */
function escapeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word.replace(/"/g, '""')}"`)
    .join(" ");
}

const RRF_K = 60;
const RRF_VEC_CANDIDATES = 200;

/** Best-match-first rank (1-based) of each row with a bm25 value; rows with none (vector-only matches) are absent. */
function ftsRanks(rows: readonly (EntryRow & { bm25?: number })[]): Map<string, number> {
  const withBm25 = rows.filter((r) => r.bm25 !== undefined).sort((a, b) => (a.bm25 as number) - (b.bm25 as number));
  return new Map(withBm25.map((r, i) => [r.entry_id, i + 1]));
}

/**
 * Hybrid relevance (SPEC v8 11.2's M5 note): FTS and vector results each ranked independently,
 * combined by reciprocal rank fusion rather than a weighted blend of raw scores, since bm25 and
 * cosine distance are incomparable scales. Returns null when semantic_search is off or the
 * model is not cached, so the caller falls back to the exact pre-M5 bm25-normalized relevance,
 * unchanged ("exactly as it does with semantic_search off"). May append vector-only matches (no
 * FTS keyword overlap -- the whole point of semantic search) to `rows`; the caller re-filters by
 * scope and kind, since the vec0 index behind vecSearch has no scope or kind awareness.
 */
async function hybridRelevance(
  ctx: RequestContext,
  query: string,
  rows: (EntryRow & { bm25?: number })[],
  loadEmbedderFn: typeof loadEmbedder = loadEmbedder,
): Promise<Map<string, number> | null> {
  if (!isFlagOn(ctx.flags, "semantic_search") || !ctx.dataDir || !isModelCached(ctx.dataDir)) return null;
  const embedder = await loadEmbedderFn(ctx.dataDir);
  if (!embedder) return null;

  const queryVector = await embedder.embed(query);
  const vecMatches = vecSearch(ctx.db, queryVector, RRF_VEC_CANDIDATES);
  const vecRankByEntry = new Map(vecMatches.map((m) => [m.entryId, m.rank]));

  const known = new Set(rows.map((r) => r.entry_id));
  const missing = vecMatches.map((m) => m.entryId).filter((id) => !known.has(id));
  if (missing.length) {
    const extra = ctx.db
      .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.entry_id IN (${missing.map(() => "?").join(",")})`)
      .all(...missing) as EntryRow[];
    rows.push(...extra);
  }

  const ftsRankByEntry = ftsRanks(rows);
  const rrf = new Map<string, number>();
  for (const row of rows) {
    const ftsRank = ftsRankByEntry.get(row.entry_id);
    const vecRank = vecRankByEntry.get(row.entry_id);
    rrf.set(row.entry_id, (ftsRank !== undefined ? 1 / (RRF_K + ftsRank) : 0) + (vecRank !== undefined ? 1 / (RRF_K + vecRank) : 0));
  }
  const maxRrf = Math.max(1e-9, ...rrf.values());
  for (const [id, v] of rrf) rrf.set(id, v / maxRrf);
  return rrf;
}

export async function runSearch(
  ctx: RequestContext,
  input: SearchInput,
  loadEmbedderFn: typeof loadEmbedder = loadEmbedder,
): Promise<{ results: SearchResultRow[]; truncated: boolean; hint?: string }> {
  const { db } = ctx;
  const snapshot = loadAccessSnapshot(db);
  const scopes = candidateScopes(db, ctx, snapshot, input.scope ?? (input.path ? scopeOfPath(input.path) : undefined));
  if (scopes.length === 0) return { results: [], truncated: false };

  const window = timeWindow(input.since, input.until, Date.now());
  const scopeIds = scopes.map((s) => s.id);
  const placeholders = scopeIds.map(() => "?").join(",");
  const kindFilter = input.kinds?.length ? `AND e.kind IN (${input.kinds.map(() => "?").join(",")})` : "";
  const kindArgs = input.kinds ?? [];

  const isListMode = input.query === "*";
  const rows: (EntryRow & { bm25?: number })[] = isListMode
    ? (db
        .prepare(
          `SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id IN (${placeholders}) ${kindFilter}
           ORDER BY (CASE WHEN e.kind = 'journal' THEN e.created_hlc ELSE e.updated_hlc END) DESC`,
        )
        .all(...scopeIds, ...kindArgs) as EntryRow[])
    : (db
        .prepare(
          `SELECT bm25(entries_fts, 3.0, 1.0, 2.0) AS bm25, ${entryColumns("e")}
           FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
           WHERE entries_fts MATCH ? AND e.scope_id IN (${placeholders}) ${kindFilter}`,
        )
        .all(escapeFtsQuery(input.query), ...scopeIds, ...kindArgs) as (EntryRow & { bm25: number })[]);

  const rrf = isListMode ? null : await hybridRelevance(ctx, input.query, rows, loadEmbedderFn);
  const scopeIdSet = new Set(scopeIds);
  const candidateRows = rrf ? rows.filter((r) => scopeIdSet.has(r.scope_id) && (!input.kinds?.length || input.kinds.includes(r.kind))) : rows;

  const maxBm25 = isListMode ? 1 : Math.max(1e-9, ...rows.filter((r) => r.bm25 !== undefined).map((r) => -(r.bm25 as number)));
  const now = Date.now();
  const importanceOn = isFlagOn(ctx.flags, "importance");

  const scored: (SearchResultRow & { _score: number })[] = [];
  for (const row of candidateRows) {
    if (EXCLUDED_STATUSES.has(row.status) || row.purged_at) continue;
    if (!input.include_proposed && row.status === "proposed") continue;
    if (row.kind === "skill" && row.status === "proposed" && ctx.vendor !== "human" && row.created_by !== ctx.clientId) continue;

    const t = row.kind === "journal" ? hlcToMs(row.created_hlc) : hlcToMs(row.updated_hlc);
    if (window.from !== undefined && t < window.from) continue;
    if (window.to !== undefined && t > window.to) continue;

    const flags = db.prepare("SELECT problem, resolved FROM flags WHERE entry_id = ?").all(row.entry_id) as {
      problem: string;
      resolved: string | null;
    }[];
    if (flags.some((f) => f.problem === "unsafe" && f.resolved === null)) continue;
    const flagged = flags.some((f) => f.resolved === null);

    const scopeInfo = scopes.find((s) => s.id === row.scope_id)!;
    // List mode lists strictly by time (SPEC 11.2: "results are listed newest first instead of by
    // relevance"), whatever the importance flag: _score stays 0 for every row, so the stable sort
    // below leaves the SQL's own time-descending order untouched. The scope multiplier and the
    // flagged penalty are relevance adjustments and apply only to scored (non-list) search.
    let s = 0;
    if (!isListMode) {
      const relevance = rrf ? rrf.get(row.entry_id) ?? 0 : Math.max(0, -(row.bm25 ?? 0)) / maxBm25;
      const imp = importanceOn ? entryImportance(db, row, now) : 0;
      s = score(relevance, imp) * scopeInfo.multiplier;
      if (flagged) s *= 0.5;
    }

    const ref = formatRef(scopeInfo.name, row.entry_id);
    const path = entryPath({
      scope: scopeInfo.name,
      scopeKind: scopeInfo.kind,
      kind: row.kind,
      slug: row.slug,
      skillName: row.skill_name ?? undefined,
      createdAt: new Date(hlcToMs(row.created_hlc)),
    });
    if (input.path && !isUnder(path, input.path)) continue;

    scored.push({
      ref,
      path,
      scope: scopeInfo.name,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      status: row.status,
      rev: row.content_rev,
      by: clientName(db, row.updated_by),
      updated: new Date(hlcToMs(row.updated_hlc)).toISOString(),
      snippet: buildSnippet(db, row, isListMode),
      ...(row.kind === "journal" && row.significance ? { significance: row.significance } : {}),
      _score: s,
    });
  }

  scored.sort((a, b) => b._score - a._score);
  const truncated = scored.length > input.limit;
  const results = scored.slice(0, input.limit).map(({ _score, ...r }) => r);
  return { results, truncated, ...(truncated ? { hint: "More results exist; narrow with kinds, since/until, or a path prefix." } : {}) };
}

function buildSnippet(db: Database.Database, row: EntryRow, isListMode: boolean): string {
  if (isListMode) return row.summary.slice(0, 160);
  const r = db
    .prepare("SELECT snippet(entries_fts, 1, '', '', '…', 40) AS s FROM entries_fts WHERE rowid = (SELECT rowid FROM entries WHERE entry_id = ?)")
    .get(row.entry_id) as { s: string } | undefined;
  return r?.s ?? row.summary.slice(0, 160);
}
