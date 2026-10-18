import { CtxdError } from "../core/errors.js";

/**
 * SKILL.md handling (SPEC v6 sections 4.3 and 12.2). The format is the one Claude Code and Codex load:
 * YAML frontmatter with `name` and `description`, then Markdown instructions.
 * Only top-level scalar keys are interpreted; everything else is kept as written.
 */

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

export interface ParsedSkill {
  name: string;
  description: string;
  /** Raw frontmatter text between the --- lines. */
  frontmatter: string;
  /** Top-level keys in order of appearance. */
  keys: string[];
  instructions: string;
}

function invalid(message: string, field = "body"): CtxdError {
  return new CtxdError("VALIDATION", `Invalid SKILL.md: ${message}`, {}, field);
}

function splitFrontmatter(body: string): { frontmatter: string; rest: string } {
  const lines = body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trimEnd() !== "---") throw invalid("must start with a --- frontmatter line");
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (close < 0) throw invalid("frontmatter is not closed with ---");
  return { frontmatter: lines.slice(1, close).join("\n"), rest: lines.slice(close + 1).join("\n") };
}

/** A top-level key line: `key: value`, with the key optionally quoted. */
const KEY_RE = /^(["']?)([A-Za-z0-9_-]+)\1\s*:(?:\s+(.*))?$/;
const BLOCK_RE = /^[>|][+-]?\d?$/;
const isContinuation = (l: string | undefined): boolean => l !== undefined && (/^\s+\S/.test(l) || l.trim() === "");

function scalar(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t.replace(/\s+#.*$/, ""); // a plain scalar ends at a comment
}

/** Read top-level scalar keys, including `>` and `|` block scalars and multi-line plain scalars. */
function readKeys(frontmatter: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_RE.exec(lines[i] as string);
    if (!m) continue;
    const key = m[2] as string;
    const raw = (m[3] ?? "").trim();
    const more: string[] = [];
    while (isContinuation(lines[i + 1])) more.push((lines[++i] as string).trim());
    while (more.length && more[more.length - 1] === "") more.pop();
    if (BLOCK_RE.test(raw)) {
      out.set(key, raw.startsWith("|") ? more.join("\n") : more.filter(Boolean).join(" "));
    } else {
      out.set(key, [scalar(raw), ...more.filter(Boolean)].filter(Boolean).join(" "));
    }
  }
  return out;
}

/** Validate a skill entry: title is the name, body is a SKILL.md whose name matches it. */
export function parseSkill(title: string, body: string): ParsedSkill {
  if (!SKILL_NAME_RE.test(title) || title.length > SKILL_NAME_MAX) {
    throw invalid("the title must be the skill name: lowercase letters, digits and single hyphens, at most 64", "title");
  }
  const { frontmatter, rest } = splitFrontmatter(body);
  const keys = readKeys(frontmatter);
  const name = keys.get("name");
  const description = keys.get("description");
  if (name === undefined) throw invalid("frontmatter needs name");
  if (name !== title) throw invalid(`frontmatter name "${name.slice(0, 64)}" must equal the title`);
  if (!description || description.length > SKILL_DESCRIPTION_MAX) {
    throw invalid(`frontmatter needs a description of 1 to ${SKILL_DESCRIPTION_MAX} characters`);
  }
  return { name, description, frontmatter, keys: [...keys.keys()], instructions: rest };
}

/** Summary line for a skill: its description, cut to 200 characters at a word boundary. */
export function skillSummary(s: ParsedSkill): string {
  return cut(s.description, 200);
}

/** One line of the skill catalog in briefs (SPEC v6 11.1). */
export function catalogLine(s: Pick<ParsedSkill, "name" | "description">, author: string): string {
  return `- ${s.name}: ${cut(s.description, 100)} (${author})`;
}

/** Build the catalog within a character budget; returns the lines that fit and how many were left out. */
export function buildCatalog(lines: readonly string[], maxChars: number): { text: string; omitted: number } {
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > maxChars) break;
    kept.push(l);
    used += l.length + 1;
  }
  return { text: kept.join("\n"), omitted: lines.length - kept.length };
}

/**
 * The file written by native skill sync (SPEC v6 12.2): `allowed-tools` removed unless kept,
 * and a managed-by comment after the frontmatter naming the entry's reference.
 */
export function renderSyncedSkill(body: string, ref: string, keepAllowedTools = false): string {
  const { frontmatter, rest } = splitFrontmatter(body);
  let fm = frontmatter;
  if (!keepAllowedTools) {
    const lines = fm.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^["']?allowed-tools["']?\s*:/i.test(lines[i] as string)) {
        // Drop the key and everything until the next top-level line.
        while (isContinuation(lines[i + 1])) i++;
        continue;
      }
      out.push(lines[i] as string);
    }
    fm = out.join("\n");
  }
  return `---\n${fm}\n---\n<!-- ${ref}: managed by ctxd; edit it in ctxd, not here -->\n${rest}`;
}

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max - 1);
  const sp = slice.lastIndexOf(" ");
  return `${(sp > max / 2 ? slice.slice(0, sp) : slice).trimEnd()}…`;
}
