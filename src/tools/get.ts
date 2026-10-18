import type Database from "better-sqlite3";
import { accessLevel, atLeast, visibleOrRestricted, type ScopeInfo } from "../access/level.js";
import { loadAccessSnapshot } from "../store/snapshot.js";
import { CtxdError } from "../core/errors.js";
import { parsePath, entryPath, folderFor, type ParsedPath } from "../fsview/paths.js";
import type { Kind, ScopeKind } from "../core/kinds.js";
import { formatRef, parseRef } from "../model/refs.js";
import { estimateTokens } from "../core/tokens.js";
import {
  entryColumns,
  entryImportance,
  bumpRead,
  hlcToMs,
  clientInfoOf,
  clientName,
  loadScopeInfos,
  type EntryRow,
} from "./support.js";
import type { RequestContext } from "../server/context.js";

/** A scope-folder child's ctxd:// path for one kind present in it, matching fsview/paths.ts's grammar. */
function childFolderPath(scope: string, kind: Kind, scopeKind: ScopeKind): string {
  if (kind === "brief") return `ctxd://${scope}/brief.md`;
  if (kind === "skill") return `ctxd://${scope}/skills/`;
  if (kind === "journal") return `ctxd://${scope}/journal/`;
  return `ctxd://${scope}/${folderFor(kind, scopeKind)}/`;
}

/**
 * context_get (SPEC v6 sections 4.2, 8.2): ids as ULIDs, ctxd: references, ctxd:// paths, or
 * skill:<name>; folder listings with generated abstracts/overviews; one-hop related entries
 * under the traversal rule; purged entries as stubs; trimmed to max_tokens.
 */

export interface GetInput {
  ids: string[];
  related: boolean;
  max_tokens: number;
}

type EntryOut = Record<string, unknown>;
type FolderOut = { path: string; abstract: string; overview: string; children: { path: string; ref?: string; kind?: string; summary: string; status?: string }[] };

export function contextGet(ctx: RequestContext, input: GetInput): unknown {
  const { db } = ctx;
  const snapshot = loadAccessSnapshot(db);
  const client = clientInfoOf(ctx);
  const scopes = loadScopeInfos(db);
  const scopeByName = new Map(scopes.map(({ row, info }) => [row.name, { row, info }]));
  const scopeById = new Map(scopes.map(({ row, info }) => [row.scope_id, { row, info }]));

  const canRead = (scopeId: string): boolean => {
    const s = scopeById.get(scopeId);
    return !!s && atLeast(accessLevel(client, s.info, snapshot, Date.now(), ctx.assumedPools), "read");
  };

  const entries: EntryOut[] = [];
  const folders: FolderOut[] = [];

  for (const id of input.ids) {
    if (id.startsWith("skill:")) {
      const row = resolveSkillName(db, id.slice("skill:".length), canRead);
      if (row) {
        const s = scopeById.get(row.scope_id)!;
        entries.push(toEntryOut(db, row, s.row.name, s.info.kind));
      }
      continue;
    }
    if (id.startsWith("ctxd://")) {
      let parsed: ParsedPath;
      try {
        parsed = parsePath(id);
      } catch (err) {
        throw err instanceof CtxdError ? err : new CtxdError("VALIDATION", "Invalid ctxd:// path", {}, "ids");
      }
      resolvePath(db, parsed, scopeByName, canRead, entries, folders);
      continue;
    }
    const ref = parseRef(id);
    if (!ref) throw new CtxdError("VALIDATION", `Not a valid id, reference, path or skill name: ${id}`, {}, "ids");
    const row = db.prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.entry_id = ?`).get(ref.id) as EntryRow | undefined;
    if (!row || !canRead(row.scope_id)) continue; // unreadable or missing resolves to nothing, not an error
    const s = scopeById.get(row.scope_id)!;
    entries.push(toEntryOut(db, row, s.row.name, s.info.kind));
  }

  if (input.related) {
    for (const e of entries) {
      const entryId = e.id as string | undefined;
      if (!entryId) continue;
      const rels = db.prepare("SELECT type, target FROM relations WHERE entry_id = ? AND removed_event IS NULL").all(entryId) as {
        type: string;
        target: string;
      }[];
      const related: unknown[] = [];
      for (const r of rels) {
        const targetRef = parseRef(r.target);
        if (!targetRef) continue;
        const targetRow = db.prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.entry_id = ?`).get(targetRef.id) as
          | EntryRow
          | undefined;
        if (!targetRow) continue;
        const targetScope = scopeById.get(targetRow.scope_id)!;
        const visible = visibleOrRestricted(
          { ref: formatRef(targetScope.row.name, targetRow.entry_id) },
          targetScope.info,
          client,
          snapshot,
          ctx.assumedPools,
          undefined,
          Date.now(),
        );
        if ("restricted" in visible) {
          related.push(visible);
        } else {
          related.push({
            ref: visible.ref,
            type: r.type,
            direction: "outbound",
            kind: targetRow.kind,
            title: targetRow.title,
            summary: targetRow.summary,
            status: targetRow.status,
          });
        }
      }
      if (related.length) e.related = related;
    }
  }

  let truncated = false;
  if (estimateTokens(JSON.stringify({ entries, folders })) > input.max_tokens) {
    truncated = true;
    while (entries.length > 1 && estimateTokens(JSON.stringify({ entries, folders })) > input.max_tokens) entries.pop();
  }

  // Bump read_stats only for entries actually returned, not ones truncation dropped.
  for (const e of entries) {
    if (e.id) bumpRead(db, e.id as string);
  }

  return {
    entries,
    ...(folders.length ? { folders } : {}),
    truncated,
    ...(truncated ? { hint: "Fetch fewer ids, or use context_search to find what you need first." } : {}),
  };
}

function toEntryOut(db: Database.Database, row: EntryRow, scope: string, scopeKind: ScopeKind): EntryOut {
  if (row.purged_at) {
    return { ref: formatRef(scope, row.entry_id), kind: row.kind, purged: true, purged_at: row.purged_at, reason: "purged" };
  }
  const path = entryPath({
    scope,
    scopeKind,
    kind: row.kind,
    slug: row.slug,
    skillName: row.skill_name ?? undefined,
    createdAt: new Date(hlcToMs(row.created_hlc)),
  });
  return {
    id: row.entry_id,
    ref: formatRef(scope, row.entry_id),
    path,
    scope,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    body: row.body,
    tags: JSON.parse(row.tags),
    status: row.status,
    rev: row.content_rev,
    by: clientName(db, row.updated_by),
    created: new Date(hlcToMs(row.created_hlc)).toISOString(),
    updated: new Date(hlcToMs(row.updated_hlc)).toISOString(),
    ...(row.kind === "journal" && row.significance ? { significance: row.significance } : {}),
  };
}

function resolveSkillName(db: Database.Database, name: string, canRead: (scopeId: string) => boolean): EntryRow | null {
  const candidates = db
    .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.skill_name = ? AND e.status = 'active'`)
    .all(name) as EntryRow[];
  const readable = candidates.filter((c) => canRead(c.scope_id));
  if (!readable.length) return null;
  readable.sort((a, b) => (a.created_hlc < b.created_hlc ? -1 : 1));
  return readable[0]!;
}

function resolvePath(
  db: Database.Database,
  parsed: ParsedPath,
  scopeByName: Map<string, { row: { scope_id: string; name: string }; info: ScopeInfo & { id: string } }>,
  canRead: (scopeId: string) => boolean,
  entries: EntryOut[],
  folders: FolderOut[],
): void {
  if (parsed.type === "root") {
    const readableScopes = [...scopeByName.values()].filter((s) => canRead(s.row.scope_id) && s.info.kind !== "hold");
    folders.push({
      path: "ctxd://",
      abstract: `${readableScopes.length} readable scopes`,
      overview: readableScopes.map((s) => s.row.name).join("\n"),
      children: readableScopes.map((s) => ({ path: `ctxd://${s.row.name}/`, summary: s.row.name })),
    });
    return;
  }
  if (parsed.type === "scope" || parsed.type === "folder") {
    const scope = scopeByName.get(parsed.scope);
    if (!scope || !canRead(scope.row.scope_id)) return; // unreadable -> resolves to nothing
    if (parsed.type === "scope") {
      const counts = db
        .prepare("SELECT kind, COUNT(*) AS n FROM entries WHERE scope_id = ? AND status NOT IN ('deleted','purged') GROUP BY kind")
        .all(scope.row.scope_id) as { kind: Kind; n: number }[];
      folders.push({
        path: `ctxd://${parsed.scope}/`,
        abstract: scope.row.name,
        overview: counts.map((c) => `${c.kind}: ${c.n}`).join("\n"),
        children: counts.map((c) => ({ path: childFolderPath(parsed.scope, c.kind, scope.info.kind), summary: `${c.n} ${c.kind} entries` })),
      });
      return;
    }
    const kindRows = db
      .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = ? AND e.status IN ('active','proposed')`)
      .all(scope.row.scope_id, parsed.kind) as EntryRow[];
    const now = Date.now();
    const ranked = kindRows.map((r) => ({ r, imp: entryImportance(db, r, now) })).sort((a, b) => b.imp - a.imp).slice(0, 15);
    folders.push({
      path: `ctxd://${parsed.scope}/${parsed.folder}/`,
      abstract: `${kindRows.length} entries${ranked[0] ? `; top: ${ranked[0].r.summary}` : ""}`,
      overview: ranked.map(({ r }) => r.summary).join("\n"),
      children: ranked.map(({ r }) => ({
        path: `ctxd://${parsed.scope}/${parsed.folder}/${r.slug}.md`,
        ref: formatRef(scope.row.name, r.entry_id),
        kind: r.kind,
        summary: r.summary,
        status: r.status,
      })),
    });
    return;
  }
  if (parsed.type === "entry") {
    const scope = scopeByName.get(parsed.scope);
    if (!scope || !canRead(scope.row.scope_id)) return;
    const row = db
      .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = ? AND e.slug = ?`)
      .get(scope.row.scope_id, parsed.kind, parsed.slug) as EntryRow | undefined;
    if (row) entries.push(toEntryOut(db, row, scope.row.name, scope.info.kind));
    return;
  }
  if (parsed.type === "skill") {
    const scope = scopeByName.get(parsed.scope);
    if (!scope || !canRead(scope.row.scope_id)) return;
    const row = db
      .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.skill_name = ? AND e.status = 'active'`)
      .get(scope.row.scope_id, parsed.name) as EntryRow | undefined;
    if (row) entries.push(toEntryOut(db, row, scope.row.name, scope.info.kind));
    return;
  }
  // Journal-folder and bare skills/ listings are deferred: M1 slice 5 covers root, scope,
  // kind-folder and entry/skill resolution; journal day-buckets land with M2's journal surface.
}
