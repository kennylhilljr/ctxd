import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { detectSecrets, sanitize, sanitizeCapture } from "../security/redact.js";

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

/** Statuses whose entries the mirror does not show. */
const UNMIRRORED = new Set(["deleted", "archived", "superseded", "quarantined"]);

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
     WHERE e.purged_at IS NULL AND e.status NOT IN (${[...UNMIRRORED].map((s) => `'${s}'`).join(",")})
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
  return mirrorRelativePath(uri);
}

/**
 * The mirror path, relative to the mirror root, of the entry at ctxd:// `uri`. A journal entry
 * (`<scope>/journal/<y>/<m>/<d>.md#<slug>`) gets `<d>--<slug>.md`, so its file ends in `.md` like
 * every other mirror file: it is read back, and its conflict copy is a separate file (#99).
 */
export function mirrorRelativePath(uri: string): string {
  const path = uri.slice("ctxd://".length);
  const hashAt = path.indexOf("#");
  if (hashAt < 0) return path;
  const before = path.slice(0, hashAt);
  const slug = path.slice(hashAt + 1);
  return `${before.endsWith(".md") ? before.slice(0, -3) : before}--${slug}.md`;
}

/** The conflict copy of the mirror file at `path`, never `path` itself (#99). */
function conflictPathFor(path: string): string {
  return path.endsWith(".md") ? `${path.slice(0, -3)}.conflict.md` : `${path}.conflict.md`;
}

/** `path` with a lowercase entry id inserted before its `.md` extension (appended when it has none). */
function withIdSuffix(path: string, entryId: string): string {
  const id = entryId.toLowerCase();
  return path.endsWith(".md") ? `${path.slice(0, -3)}.${id}.md` : `${path}.${id}`;
}

/**
 * The mirror files of entries that share the canonical mirror file `file` (#95): its siblings with an
 * entry id before `.md`, whether or not a held file remains at `file` itself. Empty when it is not shared.
 */
export function collidingMirrorFiles(file: string): string[] {
  if (!file.endsWith(".md") || !existsSync(dirname(file))) return [];
  const base = file.slice(dirname(file).length + 1, -3);
  return readdirSync(dirname(file))
    .filter((name) => name.startsWith(`${base}.`) && /^[0-9a-z]{26}\.md$/.test(name.slice(base.length + 1)))
    .sort()
    .map((name) => join(dirname(file), name));
}

/**
 * Each entry's mirror file path (#95). An entry's file is its canonical path, unless several
 * entries share that path (an offline slug collision, compared ignoring letter case): then each of
 * them is written to the canonical path with its entry id before `.md`, so no entry overwrites
 * another's file. `shared` holds the canonical paths, lowercased, that no entry owns for that reason.
 */
function mirrorPaths(all: MarkdownRow[]): { pathOf: Map<string, string>; shared: Set<string> } {
  const canonical = new Map(all.map((row) => [row.entry_id, relativePath(row)]));
  const owners = new Map<string, number>();
  for (const path of canonical.values()) owners.set(path.toLowerCase(), (owners.get(path.toLowerCase()) ?? 0) + 1);
  const shared = new Set([...owners].filter(([, n]) => n > 1).map(([path]) => path));
  const pathOf = new Map<string, string>();
  for (const [id, path] of canonical) pathOf.set(id, shared.has(path.toLowerCase()) ? withIdSuffix(path, id) : path);
  return { pathOf, shared };
}

/**
 * Join a mirror-relative path onto the mirror root, refusing any result outside it (issue 68).
 * Defence in depth: scope names and slugs are validated when events materialize, but every
 * filesystem write, rename and unlink in the mirror goes through this check as well. A symbolic
 * link at any existing component below the root is refused too, since it could point outside.
 */
function insideRoot(root: string, path: string): string {
  const base = resolve(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CtxdError("NOT_ALLOWED", `Mirror path escapes the mirror directory: ${path.slice(0, 120)}`);
  }
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let isLink: boolean;
    try { isLink = lstatSync(current).isSymbolicLink(); } catch { break; } // the rest does not exist yet
    if (isLink) throw new CtxdError("NOT_ALLOWED", `Symbolic links are not allowed in the mirror: ${path.slice(0, 120)}`);
  }
  return target;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

export function exportMarkdown(db: Database.Database, outputDir: string, scopeName?: string): { written: number } {
  let written = 0;
  const selected = rows(db, scopeName);
  const { pathOf } = mirrorPaths(selected);
  for (const row of selected) {
    atomicWrite(insideRoot(outputDir, pathOf.get(row.entry_id)!), renderMarkdown(row));
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
  const conflictPath = conflictPathFor(path);
  atomicWrite(insideRoot(dir, conflictPath), `<!-- ${reason} -->\n${text}`);
  db.prepare(
    "INSERT INTO mirror_conflicts (path, entry_id, file_rev, current_rev, reason, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET entry_id=excluded.entry_id, file_rev=excluded.file_rev, current_rev=excluded.current_rev, reason=excluded.reason, created_at=excluded.created_at",
  ).run(path, row.entry_id, fileRev ?? null, row.content_rev, reason, nowIso());
}

/**
 * A file name is user text and may hold a secret (a rejected title falls back to it), so `mirror_skips`
 * never stores the raw path (TS-AC-2): rows are keyed by its SHA-256 and display a sanitized, redacted copy.
 */
function skipKey(path: string): string {
  return hash(path);
}

function recordSkip(db: Database.Database, path: string, err: unknown): void {
  const code = err instanceof CtxdError ? err.code : "INVALID_FILE";
  const reason = sanitizeCapture(err instanceof Error ? err.message : String(err), 500);
  const at = nowIso();
  db.prepare(
    `INSERT INTO mirror_skips (path_key, path, code, reason, attempts, first_skipped_at, last_skipped_at) VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, code = excluded.code, reason = excluded.reason, attempts = attempts + 1, last_skipped_at = excluded.last_skipped_at`,
  ).run(skipKey(path), sanitizeCapture(path, 1000), code, reason, at, at);
}

/** Records a committed import whose file has not moved yet; a failed move then records its reason. */
function markImportPending(db: Database.Database, path: string, requestId: string): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO mirror_skips (path_key, path, code, reason, attempts, first_skipped_at, last_skipped_at, pending_request_id)
     VALUES (?, ?, 'PENDING_MOVE', 'Imported; not yet moved to its canonical path', 0, ?, ?, ?)
     ON CONFLICT(path_key) DO UPDATE SET code = excluded.code, reason = excluded.reason, pending_request_id = excluded.pending_request_id`,
  ).run(skipKey(path), sanitizeCapture(path, 1000), at, at, requestId);
}

function clearSkip(db: Database.Database, path: string): void {
  db.prepare("DELETE FROM mirror_skips WHERE path_key = ?").run(skipKey(path));
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

/**
 * The request id for importing an untracked mirror file, derived from its path and content (#83).
 * Ids form a chain: each later import of the same path and content is keyed on the entry the
 * previous one created. If this path has a committed import that has not moved yet (its
 * `mirror_skips.pending_request_id`) and it is in this chain, that id is reused, so the retry
 * replays the write through writeEntry's idempotency check instead of creating a duplicate entry.
 * Otherwise the next id is used, so a file put back after a completed import is a new entry.
 */
function importRequestId(db: Database.Database, clientId: string, path: string, text: string): string {
  const idFor = (prior: string) => `mirror-import:${hash(`${path}\0${text}\0${prior}`).slice(0, 48)}`;
  const priorImport = db.prepare("SELECT entry_id FROM events WHERE client_id = ? AND request_id = ?");
  const pending = (db.prepare("SELECT pending_request_id FROM mirror_skips WHERE path_key = ?").get(skipKey(path)) as
    | { pending_request_id: string | null }
    | undefined)?.pending_request_id;
  let next = idFor("");
  for (let prior; (prior = priorImport.get(clientId, next) as { entry_id: string } | undefined);) {
    if (next === pending) return next;
    next = idFor(prior.entry_id);
  }
  return next;
}

/** A refusal by writeEntry, which runs before reconcileEdit changes anything else. */
class WriteRefused extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Applies a user edit of the mirror file at `path` (text `text`) to its entry `row`, or records a
 * conflict copy when the edit is against a stale revision or changes an immutable entry.
 */
function reconcileEdit(ctx: WriteContext, mirrorDir: string, path: string, row: MarkdownRow, text: string): "applied" | "conflict" {
  const { db } = ctx;
  const parsed = parseMarkdown(text, row.title);
  const contentChanged = parsed.title !== row.title || parsed.body !== row.body ||
    (parsed.meta.tags !== undefined && JSON.stringify(parsed.meta.tags) !== row.tags);
  const statusChanged = (parsed.meta.status !== undefined && parsed.meta.status !== row.status) ||
    (parsed.meta.review_after !== undefined && parsed.meta.review_after !== row.review_after);
  if (contentChanged && parsed.meta.rev !== row.content_rev) {
    recordConflict(db, mirrorDir, path, row, parsed.meta.rev, "The entry changed after this mirror revision.", text);
    return "conflict";
  }
  if (contentChanged && IMMUTABLE.has(row.kind)) {
    recordConflict(db, mirrorDir, path, row, parsed.meta.rev, `${row.kind} entries are immutable; create a superseding entry.`, text);
    return "conflict";
  }
  if (statusChanged && parsed.meta.status_rev !== row.status_rev) {
    recordConflict(db, mirrorDir, path, row, parsed.meta.status_rev, "The entry status changed after this mirror revision.", text);
    return "conflict";
  }
  if (contentChanged) {
    try {
      writeEntry(ctx, {
        scope: row.scope_name, id: row.entry_id, expected_rev: row.content_rev, kind: row.kind,
        title: parsed.title, body: parsed.body, tags: parsed.meta.tags, request_id: newId(),
      } as never);
    } catch (error) {
      throw new WriteRefused(error);
    }
  }
  if (parsed.meta.status && parsed.meta.status !== row.status && STATUSES.includes(parsed.meta.status as (typeof STATUSES)[number])) {
    setEntryStatus(ctx, formatRef(row.scope_name, row.entry_id), parsed.meta.status);
  }
  if (parsed.meta.review_after !== undefined && parsed.meta.review_after !== row.review_after) {
    setReviewAfter(ctx, row, parsed.meta.review_after);
  }
  return "applied";
}

/**
 * Reconciles an untracked file at `row`'s canonical path (#88): applies the edit, or keeps it as a
 * conflict copy when it is stale, unparseable or refused, and only then tracks the file. Returns
 * null, leaving the file untracked, when the edit could be neither applied nor kept.
 */
function reconcileUntracked(ctx: WriteContext, mirrorDir: string, path: string, row: MarkdownRow, text: string): "applied" | "conflict" | null {
  const { db } = ctx;
  let outcome: "applied" | "conflict";
  try {
    try {
      // One transaction, so an edit refused part way (say a valid body with an invalid review date)
      // leaves the entry unchanged and is kept whole in the conflict copy. A refusal by the write
      // path comes before any change and commits, so its rejection record is kept.
      const result = db.transaction(() => {
        try {
          return reconcileEdit(ctx, mirrorDir, path, row, text);
        } catch (err) {
          if (err instanceof WriteRefused) return err;
          throw err;
        }
      })();
      if (result instanceof WriteRefused) throw result.cause;
      outcome = result;
    } catch (err) {
      const reason = sanitizeCapture(`This edit could not be applied: ${err instanceof Error ? err.message : String(err)}`, 500);
      recordConflict(db, mirrorDir, path, row, undefined, reason, text);
      outcome = "conflict";
    }
  } catch {
    return null;
  }
  trackFile(db, path, row, text);
  return outcome;
}

const COLLISION_SKIP = "Several entries share this path (an offline slug collision); each is mirrored with its entry id in the file name. Copy any edit into the right one, then remove this file";

/**
 * A test for whether an untracked file is held as a slug collision's shared file (#95), from the
 * holds recorded before this cycle. Compared ignoring letter case, so a case-only rename keeps the hold.
 */
function collisionHolds(db: Database.Database): (path: string) => boolean {
  const rows = db.prepare("SELECT path FROM mirror_skips WHERE code = 'REV_CONFLICT' AND reason = ?").all(sanitizeCapture(COLLISION_SKIP, 500)) as { path: string }[];
  const held = new Set(rows.map((row) => row.path.toLowerCase()));
  return (path) => held.size > 0 && held.has(sanitizeCapture(path, 1000).toLowerCase());
}

export function syncMirror(ctx: WriteContext, mirrorDir: string): { written: number; applied: number; conflicts: number; archiveRequests: number } {
  if (!isFlagOn(ctx.flags, "mirror")) return { written: 0, applied: 0, conflicts: 0, archiveRequests: 0 };
  const { db } = ctx;
  const live = rows(db);
  const byId = new Map(live.map((row) => [row.entry_id, row]));
  // Mirror path -> entry, for files written but never tracked (#88). Entries that share a canonical
  // path (an offline slug collision) each have their own mirror path, and the shared canonical path
  // belongs to none of them, so it never resolves to an arbitrary entry (#95).
  const { pathOf, shared } = mirrorPaths(live);
  const byPath = new Map<string, MarkdownRow>();
  for (const row of live) byPath.set(pathOf.get(row.entry_id)!, row);
  const byPathCase = new Map<string, string>();
  for (const path of byPath.keys()) byPathCase.set(path.toLowerCase(), path);
  let applied = 0;
  let conflicts = 0;
  let archiveRequests = 0;

  const tracked = db.prepare("SELECT path, entry_id, file_hash FROM mirror_files").all() as { path: string; entry_id: string; file_hash: string }[];
  const trackedPaths = new Set(tracked.map((state) => state.path));
  const trackedByCase = new Map(tracked.map((state) => [state.path.toLowerCase(), state.path]));
  for (const state of tracked) {
    const row = byId.get(state.entry_id);
    const file = insideRoot(mirrorDir, state.path);
    if (!row) {
      removeWithConflict(db, mirrorDir, state.path);
      db.prepare("DELETE FROM mirror_files WHERE path = ?").run(state.path);
      db.prepare("DELETE FROM archive_requests WHERE entry_id = ?").run(state.entry_id);
      continue;
    }
    if (!existsSync(file)) {
      db.prepare("INSERT OR IGNORE INTO archive_requests (entry_id, path, created_at) VALUES (?, ?, ?)").run(row.entry_id, state.path, nowIso());
      archiveRequests++;
      // Tracking for a path the entry no longer uses would repeat the request every cycle (#95).
      if (pathOf.get(row.entry_id) !== state.path) db.prepare("DELETE FROM mirror_files WHERE path = ?").run(state.path);
      continue;
    }
    const text = readFileSync(file, "utf8");
    if (hash(text) !== state.file_hash) {
      let outcome: "applied" | "conflict";
      try {
        outcome = reconcileEdit(ctx, mirrorDir, state.path, row, text);
      } catch (err) {
        throw err instanceof WriteRefused ? err.cause : err;
      }
      if (outcome === "conflict") conflicts++;
      else applied++;
    }
    // The entry's mirror path moved (a slug collision appeared or was resolved, #95). Its edit, if any,
    // is applied or kept in the conflict copy above, so the old file goes; the export below writes the
    // entry at its new path. Nothing else is ever written at a path two entries share.
    // Tracking goes first: a stop in between leaves a stray file, never a missing tracked file that
    // the next cycle would take for a deletion and turn into an archive request.
    if (pathOf.get(row.entry_id) !== state.path) {
      db.prepare("DELETE FROM mirror_files WHERE path = ?").run(state.path);
      unlinkSync(file);
    }
  }

  // A journal file written under its pre-#99 name (`<day>.md--<slug>`) but never tracked is not
  // walked below (its name does not end in `.md`), so it is reconciled here against the entry now
  // mirrored at `<day>--<slug>.md`, keeping any edit, and then removed; the export writes the new file.
  for (const path of legacyJournalFiles(mirrorDir)) {
    if (trackedPaths.has(path)) continue;
    const owner = byPath.get(path.replace(/(\d{2})\.md--([^/\\]+)$/, "$1--$2.md"));
    if (!owner) continue;
    const file = insideRoot(mirrorDir, path);
    const text = readFileSync(file, "utf8");
    if (text !== renderMarkdown(owner)) {
      const outcome = reconcileUntracked(ctx, mirrorDir, path, owner, text);
      if (outcome === null) continue; // left in place, retried next cycle
      if (outcome === "applied") applied++;
      else conflicts++;
      db.prepare("DELETE FROM mirror_files WHERE path = ?").run(path);
    }
    unlinkSync(file);
  }

  // A conflict copy is never walked, so one whose scope is now sealed or whose entry was purged is
  // deleted here with its record: that plaintext must not outlive the entry on disk (#91, Spec 12.1).
  const conflictRows = db.prepare(
    "SELECT c.path, e.purged_at FROM mirror_conflicts c LEFT JOIN entries e ON e.entry_id = c.entry_id",
  ).all() as { path: string; purged_at: string | null }[];
  for (const conflict of conflictRows) {
    if (conflict.purged_at !== null || isSealedScope(db, conflict.path.split(/[\\/]/)[0] ?? "")) removeConflict(db, mirrorDir, conflict.path);
  }
  const untracked = new Set<string>();
  // Untracked edits that could not be kept elsewhere: not overwritten this cycle. Lowercased, since a
  // case-insensitive filesystem writes a path under any case to the same file.
  const keep = new Set<string>();
  const kept = (path: string) => keep.has(path.toLowerCase());
  const files = walkMarkdown(mirrorDir);
  const heldForCollision = collisionHolds(db);
  // A slug collision's shared file is held before any pending import replays, which could otherwise
  // write over it should the collision resolve earlier in this cycle (#95).
  for (const file of files) {
    const path = relative(resolve(mirrorDir), file);
    if (!trackedPaths.has(path) && (shared.has(path.toLowerCase()) || heldForCollision(path))) keep.add(path.toLowerCase());
  }
  // Files at canonical paths come first, so replaying a pending import cannot rewrite an untracked,
  // edited canonical file before it is reconciled (#88).
  const atCanonical = (file: string) => byPathCase.has(relative(resolve(mirrorDir), file).toLowerCase());
  for (const file of files.sort((a, b) => Number(!atCanonical(a)) - Number(!atCanonical(b)))) {
    const path = relative(resolve(mirrorDir), file);
    if (trackedPaths.has(path)) continue;
    // A tracked file seen under another letter case (a stop before the case-fixing rename below, on a
    // case-insensitive filesystem) is that file, not a new note: restore its canonical name (#85).
    const alias = trackedByCase.get(path.toLowerCase());
    if (alias !== undefined) {
      const canonical = insideRoot(mirrorDir, alias);
      if (existsSync(canonical) && sameInode(file, canonical)) {
        renameSync(file, canonical);
        continue;
      }
    }
    untracked.add(skipKey(path));
    try {
      const text = readFileSync(file, "utf8");
      // A file ctxd rendered (it has a `ref` line) in a sealed scope's folder is plaintext that must
      // not stay on disk (Spec 12.1). Sealing erases the scope's entries from this database, so the
      // file is matched by folder, not by entry, and removed even if its frontmatter is broken (#91).
      const ref = frontmatterRef(text);
      if (ref !== undefined && isSealedScope(db, path.split(/[\\/]/)[0] ?? "")) {
        removeWithConflict(db, mirrorDir, path);
        clearSkip(db, path);
        continue;
      }
      // A file at a live entry's canonical path with no mirror_files row was written but never
      // tracked (ctxd stopped in between), so it may hold a user edit (#88). Reconcile it against
      // the entry at that path, whatever its `ref` says, before the export below rewrites it.
      // On a case-insensitive filesystem it may be the canonical file under another case: same inode.
      let ownerPath: string | undefined = byPath.get(path) ? path : undefined;
      if (ownerPath === undefined) {
        const alias = byPathCase.get(path.toLowerCase());
        if (alias && byPath.get(alias) && sameInode(file, insideRoot(mirrorDir, alias))) ownerPath = alias;
      }
      const owner = ownerPath === undefined ? undefined : byPath.get(ownerPath);
      // An untracked file at a canonical path several entries share may hold an edit meant for any of
      // them, so it is left in place for review and never overwritten or imported (#95). It stays so
      // until it is removed, even once the collision is resolved and the path has one owner again.
      if ((owner === undefined && shared.has(path.toLowerCase())) || heldForCollision(path)) {
        // Not written this cycle, even if the collision resolves during it and the export finds one owner.
        keep.add(path.toLowerCase());
        throw new CtxdError("REV_CONFLICT", COLLISION_SKIP);
      }
      if (owner && ownerPath !== undefined) {
        clearSkip(db, path);
        if (ownerPath !== path) renameSync(file, insideRoot(mirrorDir, ownerPath)); // only fixes the name's case
        if (text === renderMarkdown(owner)) continue;
        const outcome = reconcileUntracked(ctx, mirrorDir, ownerPath, owner, text);
        if (outcome === "applied") applied++;
        else if (outcome === "conflict") conflicts++;
        else keep.add(ownerPath.toLowerCase());
        continue;
      }
      const removed = ref === undefined ? null : removeInactiveUntracked(db, mirrorDir, path, ref, text);
      if (removed) {
        clearSkip(db, path);
        if (removed === "conflict") conflicts++;
        continue;
      }
      const parsed = parseMarkdown(text, path.replace(/\.md$/, "").split(/[\\/]/).pop() ?? "New note");
      if (parsed.meta.ref) {
        clearSkip(db, path);
        continue;
      }
      const [scope] = path.split(/[\\/]/);
      if (!scope) continue;
      if (isSealedScope(db, scope)) throw new CtxdError("SCOPE_FORBIDDEN", `Mirror writes to sealed scope ${scope} are refused`);
      const input = {
        scope, kind: parsed.meta.kind ?? "note", title: parsed.title, body: parsed.body,
        tags: parsed.meta.tags, request_id: importRequestId(db, ctx.clientId, path, text),
      };
      // The import and its pending mark commit together, so a crash before the move still replays it.
      // A refused write commits its rejection record and is rethrown outside the transaction.
      const outcome = db.transaction(() => {
        let written: ReturnType<typeof writeEntry>;
        try {
          written = writeEntry(ctx, input as never);
        } catch (error) {
          return { error };
        }
        markImportPending(db, path, input.request_id);
        return { written };
      })();
      if ("error" in outcome) throw outcome.error;
      const result = outcome.written;
      if (!("held" in result)) {
        const created = rows(db).find((row) => row.entry_id === result.id);
        if (!created) {
          // A retried import whose entry is no longer mirrored (archived, deleted, quarantined while
          // the move was failing): leave the file and record why, rather than importing it again.
          throw new CtxdError("NOT_ALLOWED", "This file was already imported as an entry that is no longer active; edit it to import a new entry");
        }
        // Write the entry, with its ref, at the canonical path and track it before removing the source,
        // so a stop at any point leaves either the pending source (replayed next cycle) or a file that
        // already names its entry, never an untracked copy without a ref that would import again (#85).
        const relTarget = mirrorPaths(rows(db)).pathOf.get(created.entry_id)!;
        // An untracked edit at the target that could not be kept this cycle is not overwritten (#88).
        if (kept(relTarget)) continue;
        const target = insideRoot(mirrorDir, relTarget);
        const content = renderMarkdown(created);
        // On a case-insensitive filesystem the source may already be the target under another case.
        const sameFile = existsSync(target) && sameInode(file, target);
        atomicWrite(target, content);
        trackFile(db, relTarget, created, content);
        if (!sameFile) unlinkSync(file);
        else if (file !== target) renameSync(file, target); // only fixes the name's case
        applied++;
      }
      clearSkip(db, path);
    } catch (err) {
      // The file is left in place and retried next cycle (a partial editor save heals on its own), but
      // the refusal is recorded so `ctxd status` and `ctxd doctor` can say why the note never imported (#72).
      recordSkip(db, path, err);
    }
  }
  // A skipped file that was removed, or has since been imported, is no longer skipped.
  for (const { path_key: key } of db.prepare("SELECT path_key FROM mirror_skips").all() as { path_key: string }[]) {
    if (!untracked.has(key)) db.prepare("DELETE FROM mirror_skips WHERE path_key = ?").run(key);
  }

  let written = 0;
  const current = rows(db);
  const finalPaths = mirrorPaths(current).pathOf;
  for (const row of current) {
    const path = finalPaths.get(row.entry_id)!;
    if (kept(path)) continue;
    const content = renderMarkdown(row);
    atomicWrite(insideRoot(mirrorDir, path), content);
    trackFile(db, path, row, content);
    written++;
  }
  return { written, applied, conflicts, archiveRequests };
}

/**
 * The `ref` value in a file's leading frontmatter, read tolerantly (indented, either quote, or an
 * unclosed block), so a broken or hand-edited file ctxd rendered is still recognized (#91). A `ref:`
 * line in the body after a closed frontmatter block is not read.
 */
function frontmatterRef(raw: string): string | undefined {
  const text = raw.replace(/\r\n/g, "\n"); // an editor may have saved it with Windows line endings
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 4);
  return /^[ \t]*ref:[ \t]*["']?([^"'\s]+)/m.exec(text.slice(4, end < 0 ? undefined : end))?.[1];
}

function isSealedScope(db: Database.Database, scope: string): boolean {
  return db.prepare(
    `SELECT 1 FROM scopes s JOIN pool_grants pg ON pg.scope_id = s.scope_id JOIN pools p ON p.pool_id = pg.pool_id
     WHERE s.name = ? AND p.storage = 'sealed' LIMIT 1`,
  ).get(scope) !== undefined;
}

function removeConflict(db: Database.Database, mirrorDir: string, path: string): void {
  const conflict = insideRoot(mirrorDir, conflictPathFor(path));
  if (existsSync(conflict)) unlinkSync(conflict);
  db.prepare("DELETE FROM mirror_conflicts WHERE path = ?").run(path);
}

/**
 * Deletes the mirror file at `path`, its conflict copy and the conflict record. The conflict copy goes
 * first, so a stop in between leaves the file, which the next cycle finds again, never a lone copy.
 */
function removeWithConflict(db: Database.Database, mirrorDir: string, path: string): void {
  removeConflict(db, mirrorDir, path);
  const file = insideRoot(mirrorDir, path);
  if (existsSync(file)) unlinkSync(file);
}

/**
 * Removes an untracked file at the canonical path of the entry its `ref` names, when that entry is no
 * longer mirrored (#91): ctxd stopped between writing it and tracking it, so the tracked loop never
 * sees it. A purged entry's file and conflict copy are deleted unconditionally, as the tracked loop
 * does (sealed scopes are handled by folder before parsing). Otherwise a file whose content differs
 * from the entry's (a user edit) is kept as a conflict copy before the file goes. A ref'd file
 * anywhere else is left alone. Returns what was done, or null when nothing applies.
 */
function removeInactiveUntracked(db: Database.Database, mirrorDir: string, path: string, ref: string, text: string): "removed" | "conflict" | null {
  const entryId = parseRef(ref)?.id;
  if (!entryId) return null;
  const row = db.prepare(
    `SELECT e.*, s.name AS scope_name, s.kind AS scope_kind, '' AS author_name
     FROM entries e JOIN scopes s ON s.scope_id = e.scope_id WHERE e.entry_id = ?`,
  ).get(entryId) as MarkdownRow | undefined;
  // A live entry's file is reconciled and tracked above or rewritten by the export below.
  if (!row || (row.purged_at === null && !UNMIRRORED.has(row.status))) return null;
  let canonical: string | undefined;
  try { canonical = relativePath(row); } catch { /* a purge stub rebuilt from its event has no skill name */ }
  const atCanonical = canonical === undefined
    ? row.purged_at !== null && row.kind === "skill" && path.startsWith(`${row.scope_name}/skills/`) && /^[^/\\]+[/\\]SKILL\.md$/.test(path.slice(row.scope_name.length + 8))
    : canonical === path || withIdSuffix(canonical, row.entry_id) === path; // its own file during a slug collision (#95)
  if (!atCanonical) return null;
  if (row.purged_at !== null) {
    removeWithConflict(db, mirrorDir, path);
    return "removed";
  }
  // An archive, deletion, supersession or quarantine changes only the status, so an unedited render
  // still carries the entry's content revision, title, body and tags (every render writes tags).
  // A file that no longer parses (a partial save) counts as edited, so it is kept.
  let parsed: ReturnType<typeof parseMarkdown> | undefined;
  try { parsed = parseMarkdown(text.replace(/\r\n/g, "\n"), row.title); } catch { /* kept as a conflict copy below */ }
  const unedited = parsed !== undefined && parsed.meta.rev === row.content_rev && parsed.title === row.title &&
    parsed.body === row.body && JSON.stringify(parsed.meta.tags) === row.tags;
  if (!unedited) recordConflict(db, mirrorDir, path, row, parsed?.meta.rev, `This entry is no longer mirrored (${row.status}); your edit was not applied.`, text);
  unlinkSync(insideRoot(mirrorDir, path));
  return unedited ? "removed" : "conflict";
}

function sameInode(a: string, b: string): boolean {
  const [x, y] = [statSync(a), statSync(b)];
  return x.dev === y.dev && x.ino === y.ino;
}

function trackFile(db: Database.Database, path: string, row: MarkdownRow, content: string): void {
  db.prepare(
    "INSERT INTO mirror_files (path, entry_id, content_rev, file_hash, written_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET entry_id=excluded.entry_id, content_rev=excluded.content_rev, file_hash=excluded.file_hash, written_at=excluded.written_at",
  ).run(path, row.entry_id, row.content_rev, hash(content), nowIso());
}

/** Mirror-relative paths of journal files under their pre-#99 name, `<scope>/journal/<y>/<m>/<d>.md--<slug>`. */
function legacyJournalFiles(mirrorDir: string): string[] {
  const out: string[] = [];
  const list = (path: string) => {
    try {
      return lstatSync(join(mirrorDir, path)).isDirectory() ? readdirSync(join(mirrorDir, path)) : [];
    } catch {
      return [];
    }
  };
  for (const scope of list("")) {
    for (const year of list(join(scope, "journal")).filter((name) => /^\d{4}$/.test(name))) {
      for (const month of list(join(scope, "journal", year)).filter((name) => /^\d{2}$/.test(name))) {
        for (const name of list(join(scope, "journal", year, month))) {
          const path = join(scope, "journal", year, month, name);
          if (/^\d{2}\.md--[^/\\]+$/.test(name) && !name.endsWith(".conflict.md") && lstatSync(join(mirrorDir, path)).isFile()) out.push(path);
        }
      }
    }
  }
  return out;
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
