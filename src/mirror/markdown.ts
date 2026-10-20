import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type Database from "better-sqlite3";
import { entryPath } from "../fsview/paths.js";
import { formatRef, parseRef } from "../model/refs.js";
import { makeRev, newId, revVersion } from "../core/ids.js";
import { decodeHlc } from "../core/hlc.js";
import { nowIso } from "../core/time.js";
import { CtxdError } from "../core/errors.js";
import { writeEntry, type WriteContext } from "../store/write.js";
import type { EntryRow } from "../tools/support.js";
import type { Kind, ScopeKind } from "../core/kinds.js";
import { STATUSES } from "../core/kinds.js";
import { canonicalJson } from "../store/idempotency.js";
import { allocateOriginSeq } from "../store/origin-seq.js";
import { applyEvent } from "../store/materialize.js";
import { signStoredEvent } from "../security/event-signatures.js";
import { setEntryStatus } from "../store/tidy.js";
import { isFlagOn } from "../config/flags.js";
import { detectSecrets, sanitize } from "../security/redact.js";

interface MarkdownRow extends EntryRow {
  scope_name: string;
  scope_kind: ScopeKind;
  author_name: string;
}

export interface Frontmatter {
  ref?: string;
  kind?: Kind;
  status?: string;
  rev?: string;
  status_rev?: string;
  by?: string;
  updated?: string;
  review_after?: string | null;
  title?: string;
  tags?: string[];
}

const IMMUTABLE = new Set<Kind>(["decision", "handoff", "pointer", "journal"]);

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function rows(db: Database.Database, scopeName?: string): MarkdownRow[] {
  const args: unknown[] = [];
  let filter = "";
  if (scopeName) {
    filter = " AND s.name = ?";
    args.push(scopeName);
  }
  return db.prepare(
    `SELECT e.*, s.name AS scope_name, s.kind AS scope_kind, c.name AS author_name
     FROM entries e JOIN scopes s ON s.scope_id = e.scope_id JOIN clients c ON c.client_id = e.updated_by
     WHERE e.purged_at IS NULL AND e.status NOT IN ('deleted','archived','superseded','quarantined')
       AND NOT EXISTS (
         SELECT 1 FROM pool_grants pg JOIN pools p ON p.pool_id = pg.pool_id
         WHERE pg.scope_id = e.scope_id AND p.storage = 'sealed'
       )${filter}
     ORDER BY s.name, e.kind, e.slug`,
  ).all(...args) as MarkdownRow[];
}

function updatedIso(hlc: string): string {
  return new Date(decodeHlc(hlc).physical).toISOString();
}

function yamlValue(value: unknown): string {
  return value === null ? "null" : JSON.stringify(value);
}

export function renderMarkdown(row: MarkdownRow): string {
  const frontmatter = [
    `ref: ${yamlValue(formatRef(row.scope_name, row.entry_id))}`,
    `kind: ${yamlValue(row.kind)}`,
    `status: ${yamlValue(row.status)}`,
    `rev: ${yamlValue(row.content_rev)}`,
    `status_rev: ${yamlValue(row.status_rev)}`,
    `by: ${yamlValue(row.author_name)}`,
    `updated: ${yamlValue(updatedIso(row.updated_hlc))}`,
    `review_after: ${yamlValue(row.review_after)}`,
    `title: ${yamlValue(row.title)}`,
    `tags: ${yamlValue(JSON.parse(row.tags) as string[])}`,
  ];
  return `---\n${frontmatter.join("\n")}\n---\n# ${row.title}\n\n${row.body}\n`;
}

export function parseMarkdown(text: string, fallbackTitle: string): { meta: Frontmatter; title: string; body: string } {
  let meta: Frontmatter = {};
  let markdown = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end < 0) throw new CtxdError("VALIDATION", "Unclosed Markdown frontmatter");
    for (const line of text.slice(4, end).split("\n")) {
      const colon = line.indexOf(":");
      if (colon < 1) continue;
      const key = line.slice(0, colon).trim() as keyof Frontmatter;
      const raw = line.slice(colon + 1).trim();
      try { (meta as Record<string, unknown>)[key] = JSON.parse(raw); }
      catch { (meta as Record<string, unknown>)[key] = raw; }
    }
    markdown = text.slice(end + 5);
  }
  const heading = /^#\s+(.+)\n(?:\n)?/.exec(markdown);
  const title = String(meta.title ?? heading?.[1] ?? fallbackTitle).trim();
  const body = (heading ? markdown.slice(heading[0].length) : markdown).trimEnd();
  return { meta, title, body };
}

function relativePath(row: MarkdownRow): string {
  const uri = entryPath({
    scope: row.scope_name,
    scopeKind: row.scope_kind,
    kind: row.kind,
    slug: row.slug,
    skillName: row.skill_name ?? undefined,
    createdAt: new Date(decodeHlc(row.created_hlc).physical),
  });
  return uri.slice("ctxd://".length).replace("#", "--");
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

export function exportMarkdown(db: Database.Database, outputDir: string, scopeName?: string): { written: number } {
  let written = 0;
  for (const row of rows(db, scopeName)) {
    atomicWrite(join(outputDir, relativePath(row)), renderMarkdown(row));
    written++;
  }
  return { written };
}

export function confirmArchiveRequest(ctx: WriteContext, ref: string): void {
  const parsed = parseRef(ref);
  const entryId = parsed?.id ?? ref;
  const request = ctx.db.prepare("SELECT entry_id FROM archive_requests WHERE entry_id = ?").get(entryId);
  if (!request) throw new CtxdError("NOT_FOUND", `Archive request not found: ${ref}`);
  const scope = ctx.db.prepare(
    "SELECT s.name FROM entries e JOIN scopes s ON s.scope_id = e.scope_id WHERE e.entry_id = ?",
  ).get(entryId) as { name: string } | undefined;
  if (!scope) throw new CtxdError("NOT_FOUND", `Entry not found: ${ref}`);
  setEntryStatus(ctx, formatRef(scope.name, entryId), "archived");
  ctx.db.prepare("DELETE FROM archive_requests WHERE entry_id = ?").run(entryId);
}

function recordConflict(db: Database.Database, dir: string, path: string, row: MarkdownRow, fileRev: string | undefined, reason: string, text: string): void {
  const conflictPath = path.replace(/\.md$/, ".conflict.md");
  atomicWrite(join(dir, conflictPath), `<!-- ${reason} -->\n${text}`);
  db.prepare(
    "INSERT INTO mirror_conflicts (path, entry_id, file_rev, current_rev, reason, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET file_rev=excluded.file_rev, current_rev=excluded.current_rev, reason=excluded.reason, created_at=excluded.created_at",
  ).run(path, row.entry_id, fileRev ?? null, row.content_rev, reason, nowIso());
}

function setReviewAfter(ctx: WriteContext, row: MarkdownRow, value: string | null): void {
  const current = ctx.db.prepare("SELECT status_rev, review_after FROM entries WHERE entry_id = ?").get(row.entry_id) as { status_rev: string; review_after: string | null };
  const eventId = newId();
  const hlc = ctx.clock.tick();
  const rev = makeRev(revVersion(current.status_rev) + 1, eventId);
  const payload = { review_after: value };
  const prev = { review_after: current.review_after };
  const seq = allocateOriginSeq(ctx.db, ctx.nodeId);
  ctx.db.transaction(() => {
    ctx.db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'status', 'status', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(eventId, ctx.nodeId, seq, hlc, row.scope_id, row.entry_id, canonicalJson([current.status_rev]), rev, ctx.clientId, canonicalJson(payload), canonicalJson(prev), nowIso());
    signStoredEvent(ctx.db, eventId, ctx.flags);
    applyEvent(ctx.db, { eventId, scopeId: row.scope_id, entryId: row.entry_id, op: "status", part: "status", rev, clientId: ctx.clientId, hlc, payload, prev });
  })();
}

export function syncMirror(ctx: WriteContext, mirrorDir: string): { written: number; applied: number; conflicts: number; archiveRequests: number } {
  if (!isFlagOn(ctx.flags, "mirror")) return { written: 0, applied: 0, conflicts: 0, archiveRequests: 0 };
  const { db } = ctx;
  const byId = new Map(rows(db).map((row) => [row.entry_id, row]));
  let applied = 0;
  let conflicts = 0;
  let archiveRequests = 0;

  const tracked = db.prepare("SELECT path, entry_id, file_hash FROM mirror_files").all() as { path: string; entry_id: string; file_hash: string }[];
  const trackedPaths = new Set(tracked.map((state) => state.path));
  for (const state of tracked) {
    const row = byId.get(state.entry_id);
    const file = join(mirrorDir, state.path);
    if (!row) {
      if (existsSync(file)) unlinkSync(file);
      const conflict = file.replace(/\.md$/, ".conflict.md");
      if (existsSync(conflict)) unlinkSync(conflict);
      db.prepare("DELETE FROM mirror_files WHERE path = ?").run(state.path);
      db.prepare("DELETE FROM mirror_conflicts WHERE path = ?").run(state.path);
      db.prepare("DELETE FROM archive_requests WHERE entry_id = ?").run(state.entry_id);
      continue;
    }
    if (!existsSync(file)) {
      db.prepare("INSERT OR IGNORE INTO archive_requests (entry_id, path, created_at) VALUES (?, ?, ?)").run(row.entry_id, state.path, nowIso());
      archiveRequests++;
      continue;
    }
    const text = readFileSync(file, "utf8");
    if (hash(text) === state.file_hash) continue;
    const parsed = parseMarkdown(text, row.title);
    const contentChanged = parsed.title !== row.title || parsed.body !== row.body ||
      (parsed.meta.tags !== undefined && JSON.stringify(parsed.meta.tags) !== row.tags);
    const statusChanged = (parsed.meta.status !== undefined && parsed.meta.status !== row.status) ||
      (parsed.meta.review_after !== undefined && parsed.meta.review_after !== row.review_after);
    if (contentChanged && parsed.meta.rev !== row.content_rev) {
      recordConflict(db, mirrorDir, state.path, row, parsed.meta.rev, "The entry changed after this mirror revision.", text);
      conflicts++;
      continue;
    }
    if (contentChanged && IMMUTABLE.has(row.kind)) {
      recordConflict(db, mirrorDir, state.path, row, parsed.meta.rev, `${row.kind} entries are immutable; create a superseding entry.`, text);
      conflicts++;
      continue;
    }
    if (statusChanged && parsed.meta.status_rev !== row.status_rev) {
      recordConflict(db, mirrorDir, state.path, row, parsed.meta.status_rev, "The entry status changed after this mirror revision.", text);
      conflicts++;
      continue;
    }
    if (contentChanged) {
      writeEntry(ctx, {
        scope: row.scope_name, id: row.entry_id, expected_rev: row.content_rev, kind: row.kind,
        title: parsed.title, body: parsed.body, tags: parsed.meta.tags, request_id: newId(),
      } as never);
    }
    if (parsed.meta.status && parsed.meta.status !== row.status && STATUSES.includes(parsed.meta.status as (typeof STATUSES)[number])) {
      setEntryStatus(ctx, formatRef(row.scope_name, row.entry_id), parsed.meta.status);
    }
    if (parsed.meta.review_after !== undefined && parsed.meta.review_after !== row.review_after) {
      setReviewAfter(ctx, row, parsed.meta.review_after);
    }
    applied++;
  }

  for (const file of walkMarkdown(mirrorDir)) {
    const path = relative(resolve(mirrorDir), file);
    if (trackedPaths.has(path)) continue;
    try {
      const parsed = parseMarkdown(readFileSync(file, "utf8"), path.replace(/\.md$/, "").split(/[\\/]/).pop() ?? "New note");
      if (parsed.meta.ref) continue;
      const [scope] = path.split(/[\\/]/);
      if (!scope) continue;
      const sealed = db.prepare(
        `SELECT 1 FROM scopes s JOIN pool_grants pg ON pg.scope_id = s.scope_id JOIN pools p ON p.pool_id = pg.pool_id
         WHERE s.name = ? AND p.storage = 'sealed' LIMIT 1`,
      ).get(scope);
      if (sealed) throw new CtxdError("SCOPE_FORBIDDEN", `Mirror writes to sealed scope ${scope} are refused`);
      const result = writeEntry(ctx, {
        scope, kind: parsed.meta.kind ?? "note", title: parsed.title, body: parsed.body,
        tags: parsed.meta.tags, request_id: newId(),
      } as never);
      if (!("held" in result)) {
        const created = rows(db).find((row) => row.entry_id === result.id);
        if (created) {
          const target = join(mirrorDir, relativePath(created));
          mkdirSync(dirname(target), { recursive: true });
          if (resolve(file) !== resolve(target)) renameSync(file, target);
        }
        applied++;
      }
    } catch {
      // A partial or invalid editor save is left in place for the next polling cycle.
    }
  }

  let written = 0;
  for (const row of rows(db)) {
    const path = relativePath(row);
    const content = renderMarkdown(row);
    atomicWrite(join(mirrorDir, path), content);
    db.prepare(
      "INSERT INTO mirror_files (path, entry_id, content_rev, file_hash, written_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET entry_id=excluded.entry_id, content_rev=excluded.content_rev, file_hash=excluded.file_hash, written_at=excluded.written_at",
    ).run(path, row.entry_id, row.content_rev, hash(content), nowIso());
    written++;
  }
  return { written, applied, conflicts, archiveRequests };
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new CtxdError("NOT_ALLOWED", `Symbolic links are not allowed in Markdown input: ${path}`);
    if (stat.isDirectory()) out.push(...walkMarkdown(path));
    else if (stat.isFile() && name.endsWith(".md") && !name.endsWith(".conflict.md")) out.push(path);
  }
  return out;
}

export function importMarkdown(ctx: WriteContext, dir: string, scope: string, dryRun = false, confirmed = false): { imported: number; skipped: string[]; warnings: string[]; confirmationRequired: boolean } {
  const root = resolve(dir);
  let imported = 0;
  const skipped: string[] = [];
  const files = walkMarkdown(root);
  const warnings: string[] = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const changed = sanitize(text) !== text;
    const secrets = detectSecrets(sanitize(text));
    if (changed) warnings.push(`${relative(root, path)}: sanitizer will remove private or invisible content`);
    if (secrets.length) warnings.push(`${relative(root, path)}: rejected secret patterns: ${secrets.join(", ")}`);
  }
  if (warnings.length && !dryRun && !confirmed) return { imported: 0, skipped, warnings, confirmationRequired: true };
  for (const path of files) {
    try {
      const fallback = relative(root, path).replace(/\.md$/, "").split(/[\\/]/).pop() ?? "Imported note";
      const parsed = parseMarkdown(readFileSync(path, "utf8"), fallback);
      const kind = parsed.meta.kind ?? "note";
      if (parsed.meta.ref) { skipped.push(`${relative(root, path)}: already has a ctxd ref`); continue; }
      if (!dryRun) {
        const result = writeEntry(ctx, { scope, kind, title: parsed.title, body: parsed.body, tags: parsed.meta.tags, request_id: newId() } as never);
        if ("held" in result) { skipped.push(`${relative(root, path)}: ${result.message}`); continue; }
      }
      imported++;
    } catch (err) {
      skipped.push(`${relative(root, path)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { imported, skipped, warnings, confirmationRequired: false };
}
