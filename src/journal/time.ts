import { CtxdError } from "../core/errors.js";

/**
 * Time filters for search (`since`, `until`) and the weekly digest's ISO week (SPEC v6 8.2, 11.5).
 */

const UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** Parse an ISO date or time, or a relative age such as `7d`, `2w` or `12h`, into epoch milliseconds. */
export function parseWhen(value: string, now: number, field = "since"): number {
  const v = value.trim();
  const rel = /^(\d{1,4})([hdw])$/i.exec(v);
  if (rel) return now - Number(rel[1]) * (UNIT_MS[(rel[2] as string).toLowerCase()] as number);
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) {
    const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
    if (!Number.isNaN(t)) return t;
  }
  throw new CtxdError("VALIDATION", `Invalid ${field}`, { got: v.slice(0, 25) }, field, "Use an ISO date such as 2026-10-01, or an age such as 7d, 2w or 12h.");
}

/** Resolve a since/until pair; `until` must not precede `since`. */
export function timeWindow(
  since: string | undefined,
  until: string | undefined,
  now: number,
): { from?: number; to?: number } {
  const from = since === undefined ? undefined : parseWhen(since, now, "since");
  const to = until === undefined ? undefined : parseWhen(until, now, "until");
  if (from !== undefined && to !== undefined && to < from) {
    throw new CtxdError("VALIDATION", "until is before since", {}, "until");
  }
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

/** ISO 8601 week id of a UTC instant, e.g. 2026-W42. */
export function isoWeek(at: number): string {
  const d = new Date(at);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 4)) / (7 * 86_400_000) + ((new Date(Date.UTC(year, 0, 4)).getUTCDay() + 6) % 7) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Idempotency key of a weekly digest (SPEC v6 11.5). */
export function digestRequestId(scopeId: string, at: number): string {
  return `digest:${scopeId}:${isoWeek(at)}`;
}
