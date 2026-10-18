import { isValidDate, localDate } from "../core/dates.js";
import { CtxdError } from "../core/errors.js";
import type { Kind, ScopeKind } from "../core/kinds.js";
import { SKILL_NAME_RE } from "../skills/skillmd.js";

export { localDate };

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
const SLUG_RE = SKILL_NAME_RE; // same grammar: lowercase words joined by single hyphens
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

export type SummaryFile = ".abstract" | ".overview";

/** Where a folder summary belongs: the root, a scope, a kind folder, a skill folder or a journal folder. */
export type FolderRef =
  | { at: "root" }
  | { at: "scope"; scope: string }
  | { at: "kind"; scope: string; folder: string; kind: Kind }
  | { at: "skill"; scope: string; name: string }
  | { at: "journal"; scope: string; year?: string; month?: string };

export type ParsedPath =
  | { type: "root" }
  | { type: "scope"; scope: string }
  | { type: "summary"; of: FolderRef; file: SummaryFile }
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

const isSummary = (s: string | undefined): s is SummaryFile => s === ".abstract" || s === ".overview";

/** `_me` and `_me.<pool>` keep facts in profile/; every other scope uses facts/ (SPEC v6 4.2). */
const isProfileScope = (scope: string): boolean => scope === "_me" || scope.startsWith("_me.");

/**
 * Parse a ctxd:// path. Rejects traversal, empty segments, unknown folders, impossible dates,
 * fragments outside journal day files, and the facts folder that does not belong to the scope.
 */
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
  const seg = rest === "" ? [] : rest.split("/");
  if (seg.some((x) => x === "" || x === "." || x === "..")) throw invalid(path, "empty or relative segment");

  const parsed = parseSegments(path, seg);
  if (fragment !== undefined) {
    if (parsed.type !== "journalDay") throw invalid(path, "fragments are only for journal day files");
    if (!SLUG_RE.test(fragment)) throw invalid(path, "bad slug");
    return { ...parsed, slug: fragment };
  }
  return parsed;
}

function parseSegments(path: string, seg: string[]): ParsedPath {
  const end = (n: number): void => {
    if (seg.length > n) throw invalid(path, "trailing segments");
  };
  const [scope, a, b, c, d] = seg;
  if (scope === undefined) return { type: "root" };
  if (isSummary(scope)) {
    end(1);
    return { type: "summary", of: { at: "root" }, file: scope };
  }
  if (!SCOPE_RE.test(scope)) throw invalid(path, "bad scope name");
  if (a === undefined) return { type: "scope", scope };
  if (isSummary(a)) {
    end(2);
    return { type: "summary", of: { at: "scope", scope }, file: a };
  }
  if (a === "brief.md") {
    end(2);
    return { type: "brief", scope };
  }

  if (a === "skills") {
    if (b === undefined) return { type: "skills", scope };
    if (isSummary(b)) throw invalid(path, "the skills folder has no summary files");
    if (!SKILL_NAME_RE.test(b) || b.length > 64) throw invalid(path, "bad skill name");
    if (c === undefined) return { type: "skill", scope, name: b, file: false };
    end(4);
    if (c === "SKILL.md") return { type: "skill", scope, name: b, file: true };
    if (isSummary(c)) return { type: "summary", of: { at: "skill", scope, name: b }, file: c };
    throw invalid(path, "a skill folder holds only SKILL.md");
  }

  if (a === "journal") {
    end(5);
    if (b === undefined) return { type: "journal", scope };
    if (!/^\d{4}$/.test(b)) throw invalid(path, "bad year");
    if (c === undefined) return { type: "journal", scope, year: b };
    if (isSummary(c)) {
      end(4);
      return { type: "summary", of: { at: "journal", scope, year: b }, file: c };
    }
    if (!/^(0[1-9]|1[0-2])$/.test(c)) throw invalid(path, "bad month");
    if (d === undefined) return { type: "journal", scope, year: b, month: c };
    if (isSummary(d)) return { type: "summary", of: { at: "journal", scope, year: b, month: c }, file: d };
    const m = /^(\d{2})\.md$/.exec(d);
    if (!m || !isValidDate(Number(b), Number(c), Number(m[1]))) throw invalid(path, "bad day file");
    return { type: "journalDay", scope, year: b, month: c, day: m[1] as string };
  }

  const kind = KIND_BY_FOLDER[a];
  if (!kind) throw invalid(path, `unknown folder ${a.slice(0, 40)}`);
  if (kind === "fact" && (a === PROFILE_FOLDER) !== isProfileScope(scope)) {
    throw invalid(path, isProfileScope(scope) ? "facts in _me live in profile/" : "profile/ exists only in _me scopes");
  }
  if (b === undefined) return { type: "folder", scope, folder: a, kind };
  end(3);
  if (isSummary(b)) return { type: "summary", of: { at: "kind", scope, folder: a, kind }, file: b };
  if (!b.endsWith(".md")) throw invalid(path, "entry files are <slug>.md");
  const slug = b.slice(0, -3);
  if (!SLUG_RE.test(slug)) throw invalid(path, "bad slug");
  return { type: "entry", scope, folder: a, kind, slug };
}

/** True when `path` is the folder `prefix` or inside it (for context_search `path`). */
export function isUnder(path: string, prefix: string): boolean {
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path === prefix || path.startsWith(p);
}
