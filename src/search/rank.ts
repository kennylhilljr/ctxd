/**
 * Search scoring (SPEC v6 section 11.2): 0.7 * normalized bm25 relevance + 0.3 * importance.
 * Importance (model/importance.ts) already folds in the kind weight and recency that an
 * earlier spec version scored separately here; this file previously implemented that older
 * formula (its own KIND_WEIGHTS table, now superseded by importance.ts's) with no test ever
 * written against it and nothing importing it. Corrected before anything started relying on it.
 */
export function score(relevance: number, importance: number): number {
  return 0.7 * relevance + 0.3 * importance;
}
