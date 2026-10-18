import { FLAG_PROBLEMS, KINDS, RELATION_TYPES, SIGNIFICANCES } from "../core/kinds.js";

/**
 * Server-side alias coercion for enum inputs (SPEC v6 section 8.5).
 * Runs before zod validation. Aliases never appear in tool definitions, so they cost no tokens.
 */

export interface Coercion {
  field: string;
  from: string;
  to: string;
}

type AliasTable = Readonly<Record<string, string>>;

const kindAliases: AliasTable = {
  ...Object.fromEntries(KINDS.map((k) => [`${k}s`, k])),
  statuses: "status",
  pref: "preference",
  prefs: "preference",
  log: "journal",
  journal_entry: "journal",
  rule: "convention",
  todo: "task",
  link: "pointer",
};

const significanceAliases: AliasTable = {
  block: "blocker",
  blocked: "blocker",
  outage: "incident",
  broken: "incident",
  done: "milestone",
  shipped: "milestone",
  insight: "breakthrough",
  normal: "routine",
  info: "routine",
};

const problemAliases: AliasTable = {
  incorrect: "wrong",
  outdated: "stale",
  dup: "duplicate",
  duplicated: "duplicate",
  dangerous: "unsafe",
  malicious: "unsafe",
};

const sizeAliases: AliasTable = {
  small: "micro",
  short: "micro",
  medium: "normal",
  default: "normal",
  large: "full",
  long: "full",
};

const handoffActionAliases: AliasTable = { get: "latest", read: "latest" };
const claimActionAliases: AliasTable = { take: "claim", start: "claim", done: "release", finish: "release" };

const linkTypeAliases: AliasTable = {
  supersede: "supersedes",
  replaces: "supersedes",
  implement: "implements",
  derived: "derived_from",
  related: "relates_to",
  relates: "relates_to",
  causes: "caused",
  resolves: "resolved",
  fixes: "resolved",
  fixed: "resolved",
};

/** Canonical values per alias table, used to accept canonical input unchanged. */
export const ALIAS_TABLES = {
  kind: { aliases: kindAliases, values: KINDS as readonly string[] },
  significance: { aliases: significanceAliases, values: SIGNIFICANCES as readonly string[] },
  problem: { aliases: problemAliases, values: FLAG_PROBLEMS as readonly string[] },
  size: { aliases: sizeAliases, values: ["micro", "normal", "full"] as readonly string[] },
  handoffAction: { aliases: handoffActionAliases, values: ["write", "latest"] as readonly string[] },
  claimAction: { aliases: claimActionAliases, values: ["claim", "release", "list"] as readonly string[] },
  linkType: { aliases: linkTypeAliases, values: RELATION_TYPES as readonly string[] },
} as const;

export type AliasTableName = keyof typeof ALIAS_TABLES;

/** Normalize one enum value. Returns the input unchanged when nothing matches; zod then reports it. */
export function coerceValue(table: AliasTableName, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const { aliases, values } = ALIAS_TABLES[table];
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (values.includes(key)) return key;
  return Object.hasOwn(aliases, key) ? aliases[key] : value;
}

/** Which alias table applies to each field, per tool. */
const FIELD_TABLES: Record<string, Record<string, AliasTableName>> = {
  context_brief: { size: "size" },
  context_search: { kinds: "kind" },
  context_get: {},
  context_write: { kind: "kind", significance: "significance" },
  context_handoff: { action: "handoffAction" },
  context_flag: { problem: "problem" },
  context_claim: { action: "claimAction" },
};

/**
 * Coerce the enum fields of a raw tool input. Free-text fields are never touched.
 * Returns a new object and the list of coercions to report back as `coerced`.
 */
export function coerceInput(
  tool: string,
  raw: Record<string, unknown>,
): { input: Record<string, unknown>; coerced: Coercion[] } {
  const coerced: Coercion[] = [];
  const input: Record<string, unknown> = { ...raw };
  const note = (field: string, from: unknown, to: unknown): void => {
    if (typeof from === "string" && to !== from) coerced.push({ field, from, to: String(to) });
  };

  for (const [field, table] of Object.entries(FIELD_TABLES[tool] ?? {})) {
    const v = input[field];
    if (Array.isArray(v)) {
      input[field] = v.map((item, i) => {
        const out = coerceValue(table, item);
        note(`${field}[${i}]`, item, out);
        return out;
      });
    } else if (v !== undefined) {
      const out = coerceValue(table, v);
      note(field, v, out);
      input[field] = out;
    }
  }

  if (tool === "context_write" && Array.isArray(input.links)) {
    input.links = input.links.map((l: unknown, i: number) => {
      if (l === null || typeof l !== "object") return l;
      const link = { ...(l as Record<string, unknown>) };
      const out = coerceValue("linkType", link.type);
      note(`links[${i}].type`, link.type, out);
      link.type = out;
      return link;
    });
  }
  return { input, coerced };
}
