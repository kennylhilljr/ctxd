import { ulid } from "ulid";

/** ULIDs for entries, events, nodes and clients (SPEC section 5). */
export function newId(): string {
  return ulid();
}

/**
 * Entry revision token, CouchDB style: "<version>-<10 chars of event_id>" (SPEC section 4).
 * Takes the *last* 10 characters, not the first: a ULID's first 10 characters are a millisecond
 * timestamp, not random, so two events minted in the same millisecond (not rare for sync's
 * puller applying a page of events quickly, or two offline nodes editing the same entry around
 * the same time) would otherwise produce the identical rev string at the same version, and
 * src/store/materialize.ts's conflict-policy lookups (keyed on rev) could no longer tell them
 * apart. The last 10 characters sit entirely inside the ULID's 80-bit random suffix.
 */
export function makeRev(version: number, eventId: string): string {
  return `${version}-${eventId.slice(-10)}`;
}

export function revVersion(rev: string): number {
  const n = Number(rev.split("-", 1)[0]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid rev: ${rev}`);
  return n;
}
