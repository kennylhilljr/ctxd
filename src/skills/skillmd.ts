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
  const text = body.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) throw invalid("must start with a --- frontmatter line");
  const end = text.indexOf("\n---", 3);
  if (end < 0) throw invalid("frontmatter is not closed with ---");
  const after = text.indexOf("\n", end + 4);
  return { frontmatter: text.slice(4, end), rest: after < 0 ? "" : text.slice(after + 1) };
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Read top-level scalar keys, including `>` and `|` block scalars. */
function readKeys(frontmatter: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(lines[i] as string);
    if (!m) continue;
    const key = m[1] as string;
    const raw = (m[2] as string).trim();
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-" || raw === "") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] as string)) block.push((lines[++i] as string).trim());
      out.set(key, raw.startsWith("|") ? block.join("\n") : block.join(" "));
    } else {
      out.set(key, unquote(raw));
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
      if (/^allowed-tools:/.test(lines[i] as string)) {
        while (i + 1 < lines.length && /^(\s+\S|\s*-\s)/.test(lines[i + 1] as string)) i++;
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
