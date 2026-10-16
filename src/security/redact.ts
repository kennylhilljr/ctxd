/**
 * Redaction on write (SPEC sections 6 and 10.3).
 * 1. Strip <private>...</private> blocks.
 * 2. Detect likely secrets; callers reject the write with REDACTED_SECRET,
 *    naming the detector but never echoing the matched value.
 */

export interface SecretDetector {
  name: string;
  pattern: RegExp;
}

export const SECRET_DETECTORS: readonly SecretDetector[] = [
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai-api-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "private-key-block", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: "generic-secret-assignment",
    pattern: /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{16,}/i,
  },
];

const PRIVATE_BLOCK = /<private>[\s\S]*?<\/private>/gi;

export function stripPrivate(text: string): string {
  return text.replace(PRIVATE_BLOCK, "[private content removed]");
}

/** Returns the names of detectors that matched. Empty means clean. */
export function detectSecrets(text: string, detectors = SECRET_DETECTORS): string[] {
  return detectors.filter((d) => d.pattern.test(text)).map((d) => d.name);
}
