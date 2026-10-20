/** Calendar helpers for time zones (journal day files, time filters, digest weeks). */

const DAY_MS = 86_400_000;

function parts(at: number, timeZone?: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return Object.fromEntries(
    fmt.formatToParts(at).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]),
  );
}

/** Calendar date of an instant in a time zone (the node's zone when omitted). */
export function localDate(at: Date | number, timeZone?: string): { year: string; month: string; day: string } {
  const p = parts(typeof at === "number" ? at : at.getTime(), timeZone);
  const pad = (n: number | undefined, w: number): string => String(n ?? 0).padStart(w, "0");
  return { year: pad(p.year, 4), month: pad(p.month, 2), day: pad(p.day, 2) };
}

/** True when the date exists in the calendar (rejects 2026-02-31). */
export function isValidDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Offset of a time zone from UTC at an instant, in milliseconds. */
function offsetAt(at: number, timeZone?: string): number {
  const p = parts(at, timeZone);
  const asUtc = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant at which a wall-clock time occurs in a time zone. */
export function zonedTime(
  y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0, timeZone?: string,
): number {
  const wall = Date.UTC(y, m - 1, d, h, min, s, ms);
  let at = wall - offsetAt(wall, timeZone);
  const corrected = wall - offsetAt(at, timeZone);
  if (corrected !== at) at = corrected;
  return at;
}

/** ISO 8601 week id of a calendar date, e.g. 2026-W42. */
export function isoWeekOfDate(y: number, m: number, d: number): string {
  const t = Date.UTC(y, m - 1, d);
  const weekday = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = t + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The Monday-to-Monday instant range of an ISO week id, e.g. "2026-W42", in a time zone (weekly digest, SPEC v8 11.5). */
export function isoWeekBounds(weekId: string, timeZone?: string): { from: number; to: number } {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!m) throw new Error(`Invalid ISO week id: ${weekId}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // Jan 4 is always in ISO week 1, so its week's Monday anchors every other week of the year.
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(jan4 - jan4Weekday * DAY_MS + (week - 1) * 7 * DAY_MS);
  const from = zonedTime(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0, 0, 0, timeZone);
  return { from, to: from + 7 * DAY_MS };
}

/** Weekday name (lowercase, e.g. "sunday") and hour (0-23) of an instant in a time zone, for the weekly digest's day/time gate (SPEC v8 11.5). */
export function localWeekdayAndHour(at: number, timeZone?: string): { weekday: string; hour: number } {
  const found = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return {
    weekday: (found.find((p) => p.type === "weekday")?.value ?? "").toLowerCase(),
    hour: Number(found.find((p) => p.type === "hour")?.value ?? 0),
  };
}
