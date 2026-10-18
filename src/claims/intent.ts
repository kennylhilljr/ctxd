/**
 * Write intent for claims (SPEC v2 section 7.5; PRD-claims-v1 sections 4 to 6).
 * Pure functions: patterns are data, never passed to a shell or resolved on disk.
 * Adapted from coordinate-agents (MIT): Intent Map normalization and the conservative overlap test.
 */

export const MAX_PATTERNS = 50;
export const MAX_PATTERN_BYTES = 512;

const CONTROL = /[\u0000-\u001F\u007F]/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
const GLOB_CHARS = /[*?]/;
const UNSUPPORTED_GLOB = /[[\]{}]/;

export class IntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentError";
  }
}

/** Normalize one repository-relative pattern (SPEC 7.5.1). Throws IntentError when invalid. */
export function normalizePattern(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IntentError("Path patterns must be non-empty strings.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PATTERN_BYTES) {
    throw new IntentError(`Path pattern exceeds ${MAX_PATTERN_BYTES} bytes.`);
  }
  if (CONTROL.test(value)) throw new IntentError("Path pattern contains a control character.");
  if (value.startsWith("/") || value.startsWith("\\") || WINDOWS_DRIVE.test(value)) {
    throw new IntentError("Path patterns must be repository-relative.");
  }
  if (value.startsWith("!")) throw new IntentError("Path patterns cannot use negation.");
  if (UNSUPPORTED_GLOB.test(value)) {
    throw new IntentError("Braces and character classes are not supported; use *, ** and ?.");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) throw new IntentError("Path patterns cannot escape the repository.");
  const normalized = segments.filter((s) => s !== "" && s !== ".").join("/");
  if (!normalized) throw new IntentError("Path pattern is empty after normalization.");
  return normalized;
}

/** Normalize a changed file path (a literal path, so glob-like characters are allowed). */
export function normalizeChangedPath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || CONTROL.test(value)) {
    throw new IntentError("Changed file paths must be non-empty and free of control characters.");
  }
  if (value.startsWith("/") || value.startsWith("\\") || WINDOWS_DRIVE.test(value)) {
    throw new IntentError("Changed file paths must be repository-relative.");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) throw new IntentError("Changed file paths cannot escape the repository.");
  const normalized = segments.filter((s) => s !== "" && s !== ".").join("/");
  if (!normalized) throw new IntentError("Changed file path is empty after normalization.");
  return normalized;
}

/** Normalize a whole intent list. undefined stays undefined (unknown); [] means no writes. */
export function normalizeIntent(paths: readonly string[] | undefined): string[] | undefined {
  if (paths === undefined) return undefined;
  if (paths.length > MAX_PATTERNS) throw new IntentError(`At most ${MAX_PATTERNS} path patterns per claim.`);
  return [...new Set(paths.map(normalizePattern))].sort();
}

function literalPrefix(pattern: string): { prefix: string[]; wildcard: boolean } {
  const prefix: string[] = [];
  for (const segment of pattern.split("/")) {
    if (GLOB_CHARS.test(segment)) return { prefix, wildcard: true };
    prefix.push(segment);
  }
  return { prefix, wildcard: false };
}

/**
 * Conservative overlap test (SPEC 7.5.2): true when two normalized patterns may match a common path.
 * Identical patterns overlap; distinct literals never do; otherwise literal prefixes must agree on
 * every shared segment. May report false positives; never misses a true overlap.
 */
export function patternsMayOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  if (!pa.wildcard && !pb.wildcard) return false;
  const shared = Math.min(pa.prefix.length, pb.prefix.length);
  for (let i = 0; i < shared; i += 1) {
    if (pa.prefix[i] !== pb.prefix[i]) return false;
  }
  return true;
}

export interface OverlapPair {
  mine: string;
  theirs: string;
}

/** All overlapping pattern pairs between two intents. Unknown or empty intent overlaps nothing. */
export function intentOverlaps(mine: readonly string[] | undefined, theirs: readonly string[] | undefined): OverlapPair[] {
  if (!mine || !theirs) return [];
  const pairs: OverlapPair[] = [];
  for (const m of mine) for (const t of theirs) if (patternsMayOverlap(m, t)) pairs.push({ mine: m, theirs: t });
  return pairs;
}

const regexCache = new Map<string, RegExp>();

/** Compile a normalized pattern to an anchored regular expression over full repository paths. */
export function patternToRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  let body = "";
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      i += 2;
      if (pattern[i] === "/") {
        body += "(?:.*/)?";
        i += 1;
      } else {
        body += ".*";
      }
      continue;
    }
    if (ch === "*") {
      body += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      body += "[^/]";
      i += 1;
      continue;
    }
    body += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  const re = new RegExp(`^${body}$`);
  regexCache.set(pattern, re);
  return re;
}

export function pathMatches(path: string, pattern: string): boolean {
  return patternToRegex(pattern).test(path);
}

/**
 * Drift (SPEC 7.5.4): changed files not covered by any declared pattern.
 * Returns undefined when intent or changes are unknown.
 */
export function computeDrift(
  intent: readonly string[] | undefined,
  changedFiles: readonly string[] | undefined,
): string[] | undefined {
  if (!intent || !changedFiles) return undefined;
  const files = changedFiles.map(normalizeChangedPath);
  return [...new Set(files.filter((f) => !intent.some((p) => pathMatches(f, p))))].sort();
}
