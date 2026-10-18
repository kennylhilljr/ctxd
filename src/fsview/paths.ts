import type { Kind, ScopeKind } from "../core/kinds.js";
import { CtxdError } from "../core/errors.js";

/**
 * The ctxd:// filesystem view (SPEC v6 section 4.2). Paths are computed from entries;
 * only the slug is stored, fixed at create.
 */

export const PATH_PREFIX = "ctxd://";

/** Folder per kind, for kinds stored as `<folder>/<slug>.md`. */
const FOLDER_BY_KIND: Readonly<Partial<Record<Kind, string>>> = {
  status: "status",
  decision: "decisions",
  convention: "conventions",
  fact: "facts",
  lesson: "lessons",
  handoff: "handoffs",
  task: "tasks",
  pointer: "pointers",
  note: "notes",
  preference: "preferences",
};

/** Facts live in profile/ inside `_me` and `_me.<pool>` scopes. */
const PROFILE_FOLDER = "profile";

const KIND_BY_FOLDER: Readonly<Record<string, Kind>> = {
  ...Object.fromEntries(Object.entries(FOLDER_BY_KIND).map(([k, f]) => [f, k as Kind])),
  [PROFILE_FOLDER]: "fact",
};

export const ENTRY_FOLDERS: readonly string[] = Object.keys(KIND_BY_FOLDER);

const SCOPE_RE = /^[a-z0-9_][a-z0-9._@-]{0,99}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MAX = 48;

/** Compute an entry's slug at create time (SPEC v6 4.2). */
export function slugify(title: string, entryId: string, kind: Kind): string {
  let base = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length > SLUG_MAX) {
    const cut = base.slice(0, SLUG_MAX);
    const dash = cut.lastIndexOf("-");
    // Keep whole words: cut at the last "-" unless the cut already ends a word.
    const clean = base[SLUG_MAX] === "-";
    base = (clean || dash <= 0 ? cut : cut.slice(0, dash)).replace(/-+$/g, "");
  }
  if (base === "") base = kind;
  return `${base}-${entryId.slice(-6).toLowerCase()}`;
}

/** Folder for a kind in a scope, or null for kinds with their own layout (brief, skill, journal). */
export function folderFor(kind: Kind, scopeKind: ScopeKind): string | null {
  if (kind === "fact" && (scopeKind === "me" || scopeKind === "profile")) return PROFILE_FOLDER;
  return FOLDER_BY_KIND[kind] ?? null;
}

/** Calendar date of an instant in a time zone, for journal day files. */
export function localDate(at: Date, timeZone?: string): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { year: parts.year ?? "", month: parts.month ?? "", day: parts.day ?? "" };
}

export interface EntryPathInput {
  scope: string;
  scopeKind: ScopeKind;
  kind: Kind;
  slug: string;
  /** Required for skills. */
  skillName?: string;
  /** Required for journal entries: creation time. */
  createdAt?: Date;
  timeZone?: string;
}

/** The ctxd:// path of an entry. */
export function entryPath(e: EntryPathInput): string {
  const root = `${PATH_PREFIX}${e.scope}/`;
  switch (e.kind) {
    case "brief":
      return `${root}brief.md`;
    case "skill":
      if (!e.skillName) throw new CtxdError("VALIDATION", "skill entries need a skill name", {}, "title");
      return `${root}skills/${e.skillName}/SKILL.md`;
    case "journal": {
      if (!e.createdAt) throw new CtxdError("VALIDATION", "journal entries need a creation time");
      const d = localDate(e.createdAt, e.timeZone);
      return `${root}journal/${d.year}/${d.month}/${d.day}.md#${e.slug}`;
    }
    default:
      return `${root}${folderFor(e.kind, e.scopeKind)}/${e.slug}.md`;
  }
}

export type ParsedPath =
  | { type: "root" }
  | { type: "scope"; scope: string }
  | { type: "meta"; scope: string; folder: string | null; file: ".abstract" | ".overview" }
  | { type: "brief"; scope: string }
  | { type: "folder"; scope: string; folder: string; kind: Kind }
  | { type: "entry"; scope: string; folder: string; kind: Kind; slug: string }
  | { type: "skills"; scope: string }
  | { type: "skill"; scope: string; name: string; file: boolean }
  | { type: "journal"; scope: string; year?: string; month?: string }
  | { type: "journalDay"; scope: string; year: string; month: string; day: string; slug?: string };

function invalid(path: string, why: string): CtxdError {
  return new CtxdError("VALIDATION", `Invalid ctxd path: ${why}`, { path: path.slice(0, 120) }, "path");
}

/** Parse a ctxd:// path. Rejects traversal, empty segments and unknown folders (SPEC v6 4.2). */
export function parsePath(path: string): ParsedPath {
  if (!path.startsWith(PATH_PREFIX)) throw invalid(path, "must start with ctxd://");
  let rest = path.slice(PATH_PREFIX.length);
  let fragment: string | undefined;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (rest === "") {
    if (fragment !== undefined) throw invalid(path, "unexpected fragment");
    return { type: "root" };
  }
  const seg = rest.split("/");
  if (seg.some((s) => s === "" || s === "." || s === "..")) throw invalid(path, "empty or relative segment");
  const scope = seg[0] as string;
  if (!SCOPE_RE.test(scope)) throw invalid(path, "bad scope name");
  if (fragment !== undefined && seg[1] !== "journal") throw invalid(path, "fragments are only for journal days");

  const [, a, b, c, d] = seg;
  if (a === undefined) return { type: "scope", scope };
  if (a === ".abstract" || a === ".overview") {
    if (b !== undefined) throw invalid(path, "trailing segments");
    return { type: "meta", scope, folder: null, file: a };
  }
  if (a === "brief.md") {
    if (b !== undefined) throw invalid(path, "trailing segments");
    return { type: "brief", scope };
  }
  if (a === "skills") {
    if (b === undefined) return { type: "skills", scope };
    if (!SKILL_RE.test(b) || b.length > 64) throw invalid(path, "bad skill name");
    if (c === undefined) return { type: "skill", scope, name: b, file: false };
    if (c === "SKILL.md" && d === undefined) return { type: "skill", scope, name: b, file: true };
    throw invalid(path, "a skill folder holds only SKILL.md");
  }
  if (a === "journal") {
    if (seg.length > 5) throw invalid(path, "trailing segments");
    if (b === undefined) return { type: "journal", scope };
    if (!/^\d{4}$/.test(b)) throw invalid(path, "bad year");
    if (c === undefined) return { type: "journal", scope, year: b };
    if (!/^(0[1-9]|1[0-2])$/.test(c)) throw invalid(path, "bad month");
    if (d === undefined) return { type: "journal", scope, year: b, month: c };
    const m = /^(0[1-9]|[12]\d|3[01])\.md$/.exec(d);
    if (!m) throw invalid(path, "bad day file");
    if (fragment !== undefined && !SLUG_RE.test(fragment)) throw invalid(path, "bad slug");
    return { type: "journalDay", scope, year: b, month: c, day: (m[1] as string), ...(fragment ? { slug: fragment } : {}) };
  }
  const kind = KIND_BY_FOLDER[a];
  if (!kind) throw invalid(path, `unknown folder ${a.slice(0, 40)}`);
  if (b === undefined) return { type: "folder", scope, folder: a, kind };
  if (b === ".abstract" || b === ".overview") {
    if (c !== undefined) throw invalid(path, "trailing segments");
    return { type: "meta", scope, folder: a, file: b };
  }
  if (c !== undefined || !b.endsWith(".md")) throw invalid(path, "entry files are <slug>.md");
  const slug = b.slice(0, -3);
  if (!SLUG_RE.test(slug)) throw invalid(path, "bad slug");
  return { type: "entry", scope, folder: a, kind, slug };
}

/** True when `path` is the folder `prefix` or inside it (for context_search `path`). */
export function isUnder(path: string, prefix: string): boolean {
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path === prefix || path.startsWith(p);
}
