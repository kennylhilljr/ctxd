/**
 * Sanitization and redaction pipeline (SPEC v2 sections 6.1 and 10.3; PRD-trust-safety-v1 section 3).
 *
 * Order matters:
 *   1. remove <private> blocks
 *   2. strip invisible and control characters (so they cannot split a secret or hide text)
 *   3. NFC normalize
 *   4. detect secrets: agent writes are rejected; mechanical hook captures are redacted in place
 *   5. size limits: only mechanical captures are truncated, and only after steps 1 to 4
 */

export interface SecretDetector {
  name: string;
  /** Must not use the sticky or global flags; callers clone with "g" for replacement. */
  pattern: RegExp;
}

export const SECRET_DETECTORS: readonly SecretDetector[] = [
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openai-api-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  {
    name: "private-key-block",
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/,
  },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "authorization-header", pattern: /\bauthorization["']?\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;"']{8,}/i },
  { name: "bearer-token", pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: "cookie", pattern: /\b(?:set-)?cookie["']?\s*:\s*[^\r\n]{8,}/i },
  { name: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i },
  {
    name: "generic-secret-assignment",
    pattern:
      /\b[\w.-]*(?:password|passwd|secret|token|api[_-]?key|credential|cookie)[\w.-]*["']?\s*[:=]\s*["']?[^\s"',;&]{8,}/i,
  },
];

const PRIVATE_BLOCK = /<private>[\s\S]*?<\/private>/gi;

/**
 * C0 and C1 controls except tab and newline, zero-width characters U+200B to U+200F,
 * bidirectional embeddings and overrides U+202A to U+202E and isolates U+2066 to U+2069,
 * and the byte order mark U+FEFF.
 */
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

export function stripPrivate(text: string): string {
  return text.replace(PRIVATE_BLOCK, "[private content removed]");
}

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** Steps 1 to 3: safe to apply to any stored or exported text. */
export function sanitize(text: string): string {
  return stripInvisible(stripPrivate(text)).normalize("NFC");
}

/** Names of detectors that match. Empty means clean. Run on sanitized text. */
export function detectSecrets(text: string, detectors = SECRET_DETECTORS): string[] {
  return detectors.filter((d) => d.pattern.test(text)).map((d) => d.name);
}

/** Replace every detector match with [REDACTED]. Run on sanitized text. */
export function redactSecrets(text: string, detectors = SECRET_DETECTORS): string {
  return detectors.reduce(
    (acc, d) => acc.replace(new RegExp(d.pattern.source, d.pattern.flags.replace("g", "") + "g"), "[REDACTED]"),
    text,
  );
}

export type SanitizeResult =
  | { ok: true; text: string }
  | { ok: false; detectors: string[] };

/** Agent writes (SPEC 6.1): sanitize, then reject if any secret remains. Never truncates. */
export function sanitizeAgentText(text: string): SanitizeResult {
  const clean = sanitize(text);
  const found = detectSecrets(clean);
  return found.length > 0 ? { ok: false, detectors: found } : { ok: true, text: clean };
}

/** Mechanical hook captures (SPEC 6.1): sanitize, redact in place, then truncate. */
export function sanitizeCapture(text: string, maxChars: number, marker = " (truncated)"): string {
  const clean = redactSecrets(sanitize(text));
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}
