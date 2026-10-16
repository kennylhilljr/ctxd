/** Search scoring (SPEC section 11.2): 0.7 relevance + 0.2 recency + 0.1 kind weight. */

const HALF_LIFE_DAYS = 30;

export const KIND_WEIGHTS: Record<string, number> = {
  decision: 1,
  convention: 1,
  status: 0.9,
  handoff: 0.8,
  brief: 0.8,
  fact: 0.7,
  task: 0.6,
  note: 0.5,
  pointer: 0.4,
};

export function recencyScore(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

/** relevance is bm25 normalized to [0, 1], higher is better. */
export function score(relevance: number, ageDays: number, kind: string): number {
  return 0.7 * relevance + 0.2 * recencyScore(ageDays) + 0.1 * (KIND_WEIGHTS[kind] ?? 0.5);
}
