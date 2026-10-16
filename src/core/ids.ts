import { ulid } from "ulid";

/** ULIDs for entries, events, nodes and clients (SPEC section 5). */
export function newId(): string {
  return ulid();
}

/** Entry revision token, CouchDB style: "<version>-<first 10 chars of event_id>" (SPEC section 4). */
export function makeRev(version: number, eventId: string): string {
  return `${version}-${eventId.slice(0, 10)}`;
}

export function revVersion(rev: string): number {
  const n = Number(rev.split("-", 1)[0]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid rev: ${rev}`);
  return n;
}
