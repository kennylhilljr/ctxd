import type { Kind, RelationType, Significance } from "../core/kinds.js";

/**
 * Importance score (SPEC v6 section 11.3). Computed on read; never archives or deletes anything.
 * importance = 0.35 * weight + 0.25 * links + 0.25 * recency + 0.15 * use, each part in 0..1.
 */

export const KIND_WEIGHT: Readonly<Record<Exclude<Kind, "journal">, number>> = {
  brief: 1.0,
  decision: 1.0,
  convention: 0.9,
  preference: 0.85,
  skill: 0.8,
  lesson: 0.8,
  status: 0.7,
  fact: 0.6,
  handoff: 0.6,
  task: 0.6,
  note: 0.4,
  pointer: 0.3,
};

export const SIGNIFICANCE_WEIGHT: Readonly<Record<Significance, number>> = {
  incident: 0.95,
  blocker: 0.95,
  milestone: 0.8,
  breakthrough: 0.8,
  decision: 0.7,
  routine: 0.3,
};

const CAUSAL: ReadonlySet<RelationType> = new Set(["caused", "resolved", "blocks"]);
const HALF_LIFE_DAYS = 90;
const DAY_MS = 86_400_000;

export interface ImportanceInput {
  kind: Kind;
  significance?: Significance | null;
  /** Types of active inbound relations (other entries pointing at this one). */
  inbound: readonly RelationType[];
  updatedAt: number;
  now: number;
  /** Local read_stats. */
  reads: number;
  briefed: number;
}

export interface Importance {
  score: number;
  parts: { weight: number; links: number; recency: number; use: number };
}

export function importance(e: ImportanceInput): Importance {
  const weight =
    e.kind === "journal" ? SIGNIFICANCE_WEIGHT[e.significance ?? "routine"] : KIND_WEIGHT[e.kind];
  const causal = e.inbound.filter((t) => CAUSAL.has(t)).length;
  const links = Math.min(1, (e.inbound.length + 2 * causal) / 10);
  const ageDays = Math.max(0, (e.now - e.updatedAt) / DAY_MS);
  const recency = 0.5 ** (ageDays / HALF_LIFE_DAYS);
  const use = Math.min(1, Math.log2(1 + Math.max(0, e.reads) + Math.max(0, e.briefed) / 4) / 6);
  const score = 0.35 * weight + 0.25 * links + 0.25 * recency + 0.15 * use;
  return { score, parts: { weight, links, recency, use } };
}

/** One-line explanation for `ctxd show --why`. */
export function explainImportance(i: Importance): string {
  const f = (n: number): string => n.toFixed(2);
  const p = i.parts;
  return `importance ${f(i.score)} = 0.35*weight ${f(p.weight)} + 0.25*links ${f(p.links)} + 0.25*recency ${f(p.recency)} + 0.15*use ${f(p.use)}`;
}
