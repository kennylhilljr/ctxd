import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { encodeHlc, HlcClock } from "../../src/core/hlc.js";
import { deterministicId, makeRev, newId } from "../../src/core/ids.js";
import { SYSTEM_SCOPE_ID } from "../../src/core/kinds.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { pinPublicKey } from "../../src/security/event-signatures.js";
import { toWireEvent, type EventRow, type WireEvent } from "../../src/sync/apply.js";
import { pullFromPeer, type PullResponse } from "../../src/sync/pull.js";

/**
 * Peer binding (LLD replication 7.7, issue 69): a key-bound peer may deliver only signed events.
 * Each test drives the real `pullFromPeer` loop against a fake peer that serves one fixed page.
 */

function now(): string {
  return new Date().toISOString();
}

function node(name: string) {
  const db = openDatabase(":memory:", { create: true });
  const nodeId = newId();
  const humanId = newId();
  const scopeId = deterministicId("scope", "sample-app");
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, ?, 'home', ?)").run(nodeId, name, now());
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now());
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(scopeId, now());
  db.prepare("INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, '_system', 'system', 'all', 'local-only', ?)").run(SYSTEM_SCOPE_ID, now());
  return { db, nodeId, humanId, scopeId };
}

type Node = ReturnType<typeof node>;

function ctx(n: Node, signed: boolean): WriteContext {
  return { db: n.db, clock: new HlcClock(n.nodeId), nodeId: n.nodeId, clientId: n.humanId, flags: new Map([["signed_events", signed]]) };
}

/** Writes one note on `n` and returns its create event as it would travel on the wire. */
function wroteNote(n: Node, signed: boolean): WireEvent {
  writeEntry(ctx(n, signed), { scope: "sample-app", kind: "note", title: "Note", body: "Body text", request_id: newId() });
  return toWireEvent(n.db.prepare("SELECT * FROM events ORDER BY origin_seq DESC LIMIT 1").get() as EventRow);
}

/** Registers `peerNodeId` as a peer of `target`; bound peers also get their key pinned, as `ctxd node add-peer --node-id --public-key` does. */
function addPeer(target: Database.Database, peerNodeId: string | null, publicKey: string | null): string {
  const peerId = newId();
  target.prepare(
    "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, outgoing_token, created_at, remote_node_id, remote_public_key) VALUES (?, 'hub', 'http://127.0.0.1:1', 'home', ?, 'token', ?, ?, ?)",
  ).run(peerId, newId(), now(), peerNodeId, publicKey);
  if (peerNodeId && publicKey) pinPublicKey(target, peerNodeId, publicKey, 0);
  return peerId;
}

/** A fake peer serving `events` in pages of `pageSize`, ignoring the request's vector. */
function serving(events: WireEvent[], pageSize = Number.MAX_SAFE_INTEGER): typeof fetch {
  let offset = 0;
  return (async () => {
    const page = events.slice(offset, offset + pageSize);
    offset += page.length;
    const through: Record<string, number> = {};
    for (const e of page) through[e.originNode] = Math.max(through[e.originNode] ?? 0, e.originSeq);
    const body: PullResponse = { events: page, through, more: offset < events.length };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function pull(target: Node, peerId: string, events: WireEvent[], pageSize?: number) {
  return pullFromPeer(target.db, target.nodeId, { peerId, name: "hub", url: "http://127.0.0.1:1", outgoingToken: "token" }, serving(events, pageSize));
}

/** An unsigned acl event granting a client write access, claiming an arbitrary origin. */
function forgedGrant(target: Node, originNode: string): WireEvent {
  const eventId = newId();
  return {
    eventId, originNode, originSeq: 1, hlc: encodeHlc({ physical: Date.now(), counter: 0, node: originNode }),
    scopeId: SYSTEM_SCOPE_ID, entryId: deterministicId("pool", "pool-dev"), op: "acl", part: "meta", parentRevs: [], rev: makeRev(1, eventId),
    clientId: target.humanId, sessionRef: null, requestId: null, requestHash: null,
    payload: { action: "pool_create", name: "pool-dev", description: "forged" }, prev: null,
  };
}

/** The reason recorded for a refused event (#74), or undefined when none was recorded. */
function rejection(target: Node, eventId: string): string | undefined {
  return (target.db.prepare("SELECT reason FROM sync_rejections WHERE event_id = ?").get(eventId) as { reason: string } | undefined)?.reason;
}

function bound(target: Node): { peerId: string; hub: Node; hubKey: string } {
  const hub = node("hub");
  const hubKey = wroteNote(hub, true).publicKey!;
  return { peerId: addPeer(target.db, hub.nodeId, hubKey), hub, hubKey };
}

describe("peer-bound replication (LLD replication 7.7)", () => {
  // RP-AC-7, RP-AC-8
  it("refuses an unsigned acl event a key-bound peer relays under a forged origin", async () => {
    const target = node("target");
    const { peerId } = bound(target);
    const forged = forgedGrant(target, newId());

    await expect(pull(target, peerId, [forged])).resolves.toMatchObject({ rejected: 1 });
    expect(rejection(target, forged.eventId)).toMatch(/refused unsigned event/);
    expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(forged.eventId)).toBeUndefined();
    expect(target.db.prepare("SELECT 1 FROM pools WHERE name = 'pool-dev'").get()).toBeUndefined();
  });

  // RP-AC-7, RP-AC-8
  it("refuses an unsigned event a key-bound peer sends under its own origin", async () => {
    const target = node("target");
    const { peerId, hub } = bound(target);
    const forged = forgedGrant(target, hub.nodeId);
    await expect(pull(target, peerId, [forged])).resolves.toMatchObject({ rejected: 1 });
    expect(rejection(target, forged.eventId)).toMatch(/refused unsigned event/);
    expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(forged.eventId)).toBeUndefined();
    expect(target.db.prepare("SELECT 1 FROM pools WHERE name = 'pool-dev'").get()).toBeUndefined();
  });

  // RP-AC-7: the refusal does not depend on the operation; an ordinary content create is refused too.
  it("refuses an unsigned content create a key-bound peer sends under its own origin", async () => {
    const target = node("target");
    const { peerId, hub } = bound(target);
    const unsigned = wroteNote(hub, false);
    await expect(pull(target, peerId, [unsigned])).resolves.toMatchObject({ rejected: 1, pulled: 0 });
    expect(rejection(target, unsigned.eventId)).toMatch(/refused unsigned event/);
    expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(unsigned.eventId)).toBeUndefined();
    expect(target.db.prepare("SELECT 1 FROM entries WHERE entry_id = ?").get(unsigned.entryId)).toBeUndefined();
  });

  // RP-AC-10
  it("applies a signed event a key-bound peer relays from another pinned origin", async () => {
    const target = node("target");
    const { peerId } = bound(target);
    const third = node("third");
    const relayed = wroteNote(third, true);
    pinPublicKey(target.db, third.nodeId, relayed.publicKey!, 0);

    expect((await pull(target, peerId, [relayed])).pulled).toBe(1);
    expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(relayed.eventId)).toBeDefined();
  });

  // RP-AC-9
  it("lets a key-bound peer echo back this node's own older unsigned events", async () => {
    const target = node("target");
    const { peerId } = bound(target);
    const own = wroteNote(target, false);
    await expect(pull(target, peerId, [own])).resolves.toMatchObject({ pulled: 0, rejected: 0 });
  });

  // RP-AC-7
  it("treats a peer row with only a bound key as key-bound", async () => {
    const target = node("target");
    const peerId = addPeer(target.db, null, "some-public-key");
    const forged = forgedGrant(target, newId());
    await expect(pull(target, peerId, [forged])).resolves.toMatchObject({ rejected: 1 });
    expect(rejection(target, forged.eventId)).toMatch(/refused unsigned event/);
    expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(forged.eventId)).toBeUndefined();
  });

  // RP-AC-7
  it("treats a peer row with only a bound node id as key-bound", async () => {
    const target = node("target");
    const peerId = addPeer(target.db, newId(), null);
    const forged = forgedGrant(target, newId());
    await expect(pull(target, peerId, [forged])).resolves.toMatchObject({ rejected: 1 });
    expect(rejection(target, forged.eventId)).toMatch(/refused unsigned event/);
    expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(forged.eventId)).toBeUndefined();
  });

  // RP-AC-8
  it("records a refused unsigned event and still applies the rest of the page", async () => {
    const target = node("target");
    const { peerId, hub } = bound(target);
    const forged = forgedGrant(target, newId());
    const good = wroteNote(hub, true);
    await expect(pull(target, peerId, [forged, good])).resolves.toMatchObject({ rejected: 1, pulled: 1 });
    expect(rejection(target, forged.eventId)).toMatch(/refused unsigned event/);
    expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(good.eventId)).toBeDefined();
  });

  // RP-AC-5, RP-AC-7, RP-AC-8, RP-AC-10
  it("property (RP-AC-5): forged unsigned events are never stored, never stall the pull, and the signed events converge whatever the order and paging (#74)", async () => {
    const hub = node("hub");
    const third = node("third");
    const signed = [wroteNote(hub, true), wroteNote(hub, true), wroteNote(third, true), wroteNote(third, true), wroteNote(third, true)];
    const keys = new Map(signed.map((e) => [e.originNode, e.publicKey!]));
    const snapshot = (n: Node) => ({
      events: n.db.prepare("SELECT event_id FROM events ORDER BY event_id").all(),
      entries: n.db.prepare("SELECT entry_id, title, body, content_rev, status FROM entries ORDER BY entry_id").all(),
      pools: n.db.prepare("SELECT name FROM pools").all(),
    });
    const receiver = (): { target: Node; peerId: string } => {
      const target = node("target");
      const peerId = addPeer(target.db, hub.nodeId, keys.get(hub.nodeId)!);
      pinPublicKey(target.db, third.nodeId, keys.get(third.nodeId)!, 0);
      return { target, peerId };
    };

    const reference = receiver();
    await pull(reference.target, reference.peerId, signed);
    const expected = snapshot(reference.target);
    expect(expected.events).toHaveLength(signed.length);

    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(signed, { minLength: signed.length, maxLength: signed.length }),
        fc.array(fc.tuple(fc.nat({ max: signed.length }), fc.boolean()), { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 1, max: signed.length + 3 }),
        async (order, forgeries, pageSize) => {
          const { target, peerId } = receiver();
          const delivered: WireEvent[] = [...order];
          const forged: WireEvent[] = [];
          for (const [at, asHub] of forgeries) {
            const event = forgedGrant(target, asHub ? hub.nodeId : newId());
            forged.push(event);
            delivered.splice(Math.min(at, delivered.length), 0, event);
          }
          // One pull of the mixed stream converges: the forged events are recorded and skipped, not a stall.
          await expect(pull(target, peerId, delivered, pageSize)).resolves.toMatchObject({ rejected: forged.length });
          for (const event of forged) {
            expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(event.eventId)).toBeUndefined();
            expect(rejection(target, event.eventId)).toMatch(/refused unsigned event/);
          }
          expect(snapshot(target)).toEqual(expected);
          const through = Object.fromEntries(
            (target.db.prepare("SELECT origin_node, through_seq FROM sync_state WHERE peer_node = 'hub'").all() as { origin_node: string; through_seq: number }[])
              .map((r) => [r.origin_node, r.through_seq]),
          );
          // The watermark moved past the forged events: each origin's through is what the last page
          // carrying it reported (this fake peer serves shuffled pages, so that is the page's max).
          const lastReported: Record<string, number> = {};
          for (let at = 0; at < delivered.length; at += pageSize) {
            const page = delivered.slice(at, at + pageSize);
            for (const origin of new Set(page.map((e) => e.originNode))) {
              lastReported[origin] = Math.max(...page.filter((e) => e.originNode === origin).map((e) => e.originSeq));
            }
          }
          expect(through).toEqual(lastReported);
          // The peer keeps serving the forged events: a second pull still resolves, changes nothing
          // and adds no rows (each forged event's attempts go up instead).
          await expect(pull(target, peerId, delivered, pageSize)).resolves.toBeDefined();
          expect(snapshot(target)).toEqual(expected);
          expect((target.db.prepare("SELECT COUNT(*) AS n FROM sync_rejections").get() as { n: number }).n).toBe(forged.length);
        },
      ),
      { numRuns: 25 },
    );
  });

  // RP-AC-11
  it("still applies unsigned events from a legacy peer with no bound node id", async () => {
    const target = node("target");
    const peerId = addPeer(target.db, null, null);
    const legacy = node("legacy");
    const unsigned = wroteNote(legacy, false);

    expect((await pull(target, peerId, [unsigned])).pulled).toBe(1);
  });
});
