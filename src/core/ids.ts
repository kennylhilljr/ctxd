import { ulid } from "ulid";
import { sha256Hex } from "./hash.js";

/** ULIDs for entries, events, nodes and clients (SPEC section 5). */
export function newId(): string {
  return ulid();
}

/**
 * A stable id derived from a name, not random (SPEC v8 4: "access metadata... changes only
 * through acl events"). Two nodes independently creating a scope or pool of the same name while
 * partitioned must agree on its id without ever syncing first, the same way `_me`'s scope_id is
 * a fixed constant rather than a random one (M3 slice 2's fix for the same convergence gap,
 * generalized here since scope/pool names, unlike `_me`, aren't known in advance). `namespace`
 * keeps a scope and a pool of the same name from colliding.
 */
export function deterministicId(namespace: "scope" | "pool", name: string): string {
  return sha256Hex(`${namespace}:${name}`).slice(0, 26);
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
