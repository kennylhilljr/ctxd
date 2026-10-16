/** Rough token estimate used for budgets (SPEC section 11.1): ceil(chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Trim text to a token budget, appending a marker when truncated. */
export function trimToTokens(text: string, maxTokens: number, marker = " (truncated)"): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}
