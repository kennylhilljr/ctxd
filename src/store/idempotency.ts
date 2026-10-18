import { createHash } from "node:crypto";

/**
 * Idempotency (SPEC v6 section 6, step 2): a client-supplied request_id is checked against a
 * hash of the canonical input (excluding request_id itself). A retry with the same id and the
 * same input is safe; a different input under the same id is refused with IDEMPOTENCY_MISMATCH.
 */

/** Deterministic JSON with object keys sorted, so equivalent inputs always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the canonical JSON of `value`. Callers exclude request_id before calling this. */
export function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
