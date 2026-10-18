import { isoWeekOfDate, isValidDate, localDate, zonedTime } from "../core/dates.js";
import { CtxdError } from "../core/errors.js";

/**
 * Time filters for search (`since`, `until`) and the weekly digest's ISO week (SPEC v6 8.2, 11.5).
 * Dates and zone-less times are read in the node's time zone.
 */

const UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface WhenOptions {
  field?: string;
  timeZone?: string;
  /** For `until`: a date alone means the end of that day, so the day is included. */
  endOfDay?: boolean;
}

/** Parse an ISO date or time, or a relative age such as `7d`, `2w` or `12h`, into epoch milliseconds. */
export function parseWhen(value: string, now: number, opts: WhenOptions = {}): number {
  const field = opts.field ?? "since";
  const v = value.trim();
  const rel = /^(\d{1,4})([hdw])$/i.exec(v);
  if (rel) return now - Number(rel[1]) * (UNIT_MS[(rel[2] as string).toLowerCase()] as number);

  const m = ISO.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
    const ms = Number((m[7] ?? "0").padEnd(3, "0"));
    if (isValidDate(y, mo, d) && h < 24 && mi < 60 && s < 60) {
      if (m[8]) {
        const z = m[8];
        const off = z === "Z" ? 0 : (z[0] === "-" ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(-2)));
        return Date.UTC(y, mo - 1, d, h, mi, s, ms) - off * 60_000;
      }
      if (m[4] === undefined && opts.endOfDay) {
        const next = new Date(Date.UTC(y, mo - 1, d + 1));
        return zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, 0, opts.timeZone) - 1;
      }
      return zonedTime(y, mo, d, h, mi, s, ms, opts.timeZone);
    }
  }
  throw new CtxdError(
    "VALIDATION",
    `Invalid ${field}`,
    { got: v.slice(0, 25) },
    field,
    "Use an ISO date such as 2026-10-01, or an age such as 7d, 2w or 12h.",
  );
}

/** Resolve a since/until pair; `until` must not precede `since`. */
export function timeWindow(
  since: string | undefined,
  until: string | undefined,
  now: number,
  timeZone?: string,
): { from?: number; to?: number } {
  const from = since === undefined ? undefined : parseWhen(since, now, { field: "since", timeZone });
  const to = until === undefined ? undefined : parseWhen(until, now, { field: "until", timeZone, endOfDay: true });
  if (from !== undefined && to !== undefined && to < from) {
    throw new CtxdError("VALIDATION", "until is before since", {}, "until");
  }
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

/** ISO 8601 week id of an instant, by its local date in the given zone, e.g. 2026-W42. */
export function isoWeek(at: number, timeZone?: string): string {
  const d = localDate(at, timeZone);
  return isoWeekOfDate(Number(d.year), Number(d.month), Number(d.day));
}

/** Idempotency key of a weekly digest (SPEC v6 11.5), using the digest node's local week. */
export function digestRequestId(scopeId: string, at: number, timeZone?: string): string {
  return `digest:${scopeId}:${isoWeek(at, timeZone)}`;
}
