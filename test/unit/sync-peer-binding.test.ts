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

function serving(events: WireEvent[]): typeof fetch {
  const through: Record<string, number> = {};
  for (const e of events) through[e.originNode] = Math.max(through[e.originNode] ?? 0, e.originSeq);
  const body: PullResponse = { events, through, more: false };
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

function pull(target: Node, peerId: string, events: WireEvent[]) {
  return pullFromPeer(target.db, target.nodeId, { peerId, name: "hub", url: "http://127.0.0.1:1", outgoingToken: "token" }, serving(events));
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

function bound(target: Node): { peerId: string; hub: Node; hubKey: string } {
  const hub = node("hub");
  const hubKey = wroteNote(hub, true).publicKey!;
  return { peerId: addPeer(target.db, hub.nodeId, hubKey), hub, hubKey };
}

describe("peer-bound replication (LLD replication 7.7)", () => {
  it("refuses an unsigned acl event a key-bound peer relays under a forged origin", async () => {
    const target = node("target");
    const { peerId } = bound(target);
    const forged = forgedGrant(target, newId());

    await expect(pull(target, peerId, [forged])).rejects.toThrow(/refused unsigned event/);
    expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(forged.eventId)).toBeUndefined();
    expect(target.db.prepare("SELECT 1 FROM pools WHERE name = 'pool-dev'").get()).toBeUndefined();
  });

  it("refuses an unsigned event a key-bound peer sends under its own origin", async () => {
    const target = node("target");
    const { peerId, hub } = bound(target);
    await expect(pull(target, peerId, [forgedGrant(target, hub.nodeId)])).rejects.toThrow();
    expect(target.db.prepare("SELECT 1 FROM pools WHERE name = 'pool-dev'").get()).toBeUndefined();
  });

  it("applies a signed event a key-bound peer relays from another pinned origin", async () => {
    const target = node("target");
    const { peerId } = bound(target);
    const third = node("third");
    const relayed = wroteNote(third, true);
    pinPublicKey(target.db, third.nodeId, relayed.publicKey!, 0);

    expect((await pull(target, peerId, [relayed])).pulled).toBe(1);
    expect(target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(relayed.eventId)).toBeDefined();
  });

  it("lets a key-bound peer echo back this node's own older unsigned events", async () => {
    const target = node("target");
    const { peerId } = bound(target);
    const own = wroteNote(target, false);
    await expect(pull(target, peerId, [own])).resolves.toMatchObject({ pulled: 0 });
  });

  it("still applies unsigned events from a legacy peer with no bound node id", async () => {
    const target = node("target");
    const peerId = addPeer(target.db, null, null);
    const legacy = node("legacy");
    const unsigned = wroteNote(legacy, false);

    expect((await pull(target, peerId, [unsigned])).pulled).toBe(1);
  });
});
