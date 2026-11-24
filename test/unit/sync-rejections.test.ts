import fc from "fast-check";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { encodeHlc, HlcClock } from "../../src/core/hlc.js";
import { deterministicId, makeRev, newId } from "../../src/core/ids.js";
import { SYSTEM_SCOPE_ID } from "../../src/core/kinds.js";
import { openDatabase } from "../../src/store/db.js";
import { purgeEntry } from "../../src/store/purge.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { pinPublicKey } from "../../src/security/event-signatures.js";
import { toWireEvent, type EventRow, type WireEvent } from "../../src/sync/apply.js";
import { isEnvironmentalFailure, pullFromPeer } from "../../src/sync/pull.js";
import { checkSyncRejections } from "../../src/cli/doctor.js";

/**
 * Issue 74: a replicated event that fails to apply is recorded in `sync_rejections` and skipped,
 * so it can no longer stall replication from its peer; it is retried on every later pull.
 * Each test drives the real `pullFromPeer` loop against a fake peer serving fixed pages.
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
function wroteNote(n: Node, signed: boolean, title = "Note"): WireEvent {
  writeEntry(ctx(n, signed), { scope: "sample-app", kind: "note", title, body: "Body text", request_id: newId() });
  return toWireEvent(n.db.prepare("SELECT * FROM events ORDER BY origin_seq DESC LIMIT 1").get() as EventRow);
}

/** Registers the key-bound peer `hub` on `target`, pinning its key as `ctxd node add-peer --node-id --public-key` does. */
function addPeer(target: Database.Database, peerNodeId: string, publicKey: string): string {
  const peerId = newId();
  target.prepare(
    "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, outgoing_token, created_at, remote_node_id, remote_public_key) VALUES (?, 'hub', 'http://127.0.0.1:1', 'home', ?, 'token', ?, ?, ?)",
  ).run(peerId, newId(), now(), peerNodeId, publicKey);
  pinPublicKey(target, peerNodeId, publicKey, 0);
  return peerId;
}

/** A fake peer serving `items` in pages of `pageSize`, ignoring the request's vector. Items may be malformed. */
function serving(items: unknown[], pageSize = Number.MAX_SAFE_INTEGER): typeof fetch {
  let offset = 0;
  return (async () => {
    const page = items.slice(offset, offset + pageSize);
    offset += page.length;
    const through: Record<string, number> = {};
    for (const e of page) {
      if (e && typeof e === "object" && "originNode" in e) {
        const w = e as WireEvent;
        through[w.originNode] = Math.max(through[w.originNode] ?? 0, w.originSeq);
      }
    }
    return new Response(JSON.stringify({ events: page, through, more: offset < items.length }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function pull(target: Node, peerId: string, items: unknown[], pageSize?: number) {
  return pullFromPeer(target.db, target.nodeId, { peerId, name: "hub", url: "http://127.0.0.1:1", outgoingToken: "token" }, serving(items, pageSize));
}

function rejections(target: Node) {
  return target.db.prepare("SELECT event_id, reason, attempts, raw FROM sync_rejections ORDER BY event_id").all() as
    { event_id: string; reason: string; attempts: number; raw: string | null }[];
}

function throughSeq(target: Node, origin: string): number | undefined {
  return (target.db.prepare("SELECT through_seq FROM sync_state WHERE peer_node = 'hub' AND origin_node = ?").get(origin) as { through_seq: number } | undefined)?.through_seq;
}

function stored(target: Node, eventId: string): boolean {
  return target.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(eventId) !== undefined;
}

/** A signed event whose payload was changed after signing. */
function tampered(event: WireEvent): WireEvent {
  return { ...event, payload: { ...(event.payload as Record<string, unknown>), body: "Changed in transit" } };
}

/** An unsigned acl event claiming `originNode`. */
function unsignedGrant(target: Node, originNode: string): WireEvent {
  const eventId = newId();
  return {
    eventId, originNode, originSeq: 1, hlc: encodeHlc({ physical: Date.now(), counter: 0, node: originNode }),
    scopeId: SYSTEM_SCOPE_ID, entryId: deterministicId("pool", "pool-dev"), op: "acl", part: "meta", parentRevs: [], rev: makeRev(1, eventId),
    clientId: target.humanId, sessionRef: null, requestId: null, requestHash: null,
    payload: { action: "pool_create", name: "pool-dev", description: "forged" }, prev: null,
  };
}

describe("rejected replicated events (#74)", () => {
  it("records an event that fails to apply and advances past it", async () => {
    const hub = node("hub");
    const target = node("target");
    const [first, second, third] = [wroteNote(hub, true), wroteNote(hub, true), wroteNote(hub, true)];
    const peerId = addPeer(target.db, hub.nodeId, first!.publicKey!);

    const outcome = await pull(target, peerId, [first, tampered(second!), third]);

    expect(outcome).toMatchObject({ pulled: 2, rejected: 1 });
    expect(stored(target, first!.eventId) && stored(target, third!.eventId)).toBe(true);
    expect(stored(target, second!.eventId)).toBe(false);
    expect(rejections(target)).toEqual([{ event_id: second!.eventId, attempts: 1, raw: expect.any(String), reason: expect.stringMatching(/Payload hash mismatch/) }]);
    expect(throughSeq(target, hub.nodeId)).toBe(third!.originSeq);
    expect(checkSyncRejections(target.db)).toMatchObject({ ok: false, detail: expect.stringMatching(/hub: 1 rejected.*Payload hash mismatch/) });
  });

  it("does not stall when the peer serves the same bad event again; attempts go up instead of rows", async () => {
    const hub = node("hub");
    const target = node("target");
    const bad = tampered(wroteNote(hub, true));
    const peerId = addPeer(target.db, hub.nodeId, bad.publicKey!);

    await pull(target, peerId, [bad]);
    await expect(pull(target, peerId, [bad])).resolves.toMatchObject({ rejected: 2 }); // the retry, then the page
    expect(rejections(target)).toEqual([expect.objectContaining({ event_id: bad.eventId, attempts: 3 })]);
  });

  it("retries a rejected event on later pulls and applies it once it can (a relayed origin pinned late)", async () => {
    const hub = node("hub");
    const target = node("target");
    const peerId = addPeer(target.db, hub.nodeId, wroteNote(hub, true).publicKey!);
    const other = node("other");
    const relayed = wroteNote(other, true);

    await expect(pull(target, peerId, [relayed])).resolves.toMatchObject({ pulled: 0, rejected: 1 });
    expect(rejections(target)[0]!.reason).toMatch(/No authenticated public key/);
    expect(rejections(target)[0]!.raw).not.toBeNull();
    expect(throughSeq(target, other.nodeId)).toBe(relayed.originSeq);

    pinPublicKey(target.db, other.nodeId, relayed.publicKey!, 0);
    await expect(pull(target, peerId, [])).resolves.toMatchObject({ pulled: 1, rejected: 0 });
    expect(rejections(target)).toEqual([]);
    expect(stored(target, relayed.eventId)).toBe(true);
  });

  it("records a malformed item that is not an event object, and keeps applying the rest", async () => {
    const hub = node("hub");
    const target = node("target");
    const good = wroteNote(hub, true);
    const peerId = addPeer(target.db, hub.nodeId, good.publicKey!);

    await expect(pull(target, peerId, [null, 42, { eventId: { not: "a string" } }, good])).resolves.toMatchObject({ pulled: 1, rejected: 3 });
    expect(stored(target, good.eventId)).toBe(true);
    const ids = rejections(target).map((r) => r.event_id);
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("keeps a sealed item it cannot decrypt yet, as its ciphertext envelope, for a later retry", async () => {
    const hub = node("hub");
    const target = node("target");
    const peerId = addPeer(target.db, hub.nodeId, wroteNote(hub, true).publicKey!);
    const item = { sealed: true, pool_id: "pool-private", event_id: newId(), envelope: { v: 1, nonce: "AAAA", ciphertext: "AAAA", tag: "AAAA" } };

    await expect(pull(target, peerId, [item])).resolves.toMatchObject({ rejected: 1 });
    expect(rejections(target)).toEqual([expect.objectContaining({ event_id: item.event_id, raw: JSON.stringify(item) })]);
    // Retried on the next pull (still undecryptable here), not dropped.
    await expect(pull(target, peerId, [])).resolves.toMatchObject({ rejected: 1 });
    expect(rejections(target)[0]!.attempts).toBe(2);
  });

  it("a purge applied by a pull deletes the rejection rows for its entry", async () => {
    const hub = node("hub");
    const target = node("target");
    const created = writeEntry(ctx(hub, true), { scope: "sample-app", kind: "note", title: "Shared", body: "Body text", request_id: newId() });
    purgeEntry(ctx(hub, true), created.ref, "Leaked a credential.");
    const events = (hub.db.prepare("SELECT * FROM events ORDER BY origin_seq").all() as EventRow[]).map(toWireEvent);
    const entryId = events[0]!.entryId;
    const peerId = addPeer(target.db, hub.nodeId, events[0]!.publicKey!);
    target.db.prepare(
      "INSERT INTO sync_rejections (peer_node, event_id, entry_id, raw, reason, first_rejected_at, last_rejected_at) VALUES ('hub', 'e1', ?, NULL, 'r', 't', 't')",
    ).run(entryId);

    // The hub's create event is already purge-stripped, so it is refused until its purge arrives
    // (Untrusted purge stripping); the purge then applies and deletes that row and the seeded one.
    await expect(pull(target, peerId, events)).resolves.toMatchObject({ rejected: 1 });
    expect(rejections(target)).toEqual([]);
    expect(target.db.prepare("SELECT purged_at FROM entries WHERE entry_id = ?").get(entryId)).toEqual({ purged_at: expect.any(String) });
    expect(rejections(target)).toEqual([]);
  });

  it("strips control characters from a recorded reason, since peer-controlled text reaches the terminal", async () => {
    const hub = node("hub");
    const target = node("target");
    const peerId = addPeer(target.db, hub.nodeId, wroteNote(hub, true).publicKey!);
    const hostile = { ...unsignedGrant(target, "\u001b[2Jorigin\nnext\u202e\u200b\u2028line\u2029para"), eventId: "id\u001b]0;title\u0007" };

    await expect(pull(target, peerId, [hostile])).resolves.toMatchObject({ rejected: 1 });
    const [row] = rejections(target);
    expect(row!.reason).toMatch(/refused unsigned event/);
    const invisible = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
    expect(row!.reason).not.toMatch(invisible);
    expect(checkSyncRejections(target.db).detail).not.toMatch(invisible);
  });

  it("treats only non-constraint SQLite errors as environmental, whichever driver raised them", () => {
    class OtherDriverSqliteError extends Error {
      constructor(message: string, readonly code: string) { super(message); this.name = "SqliteError"; }
    }
    expect(isEnvironmentalFailure(new OtherDriverSqliteError("busy", "SQLITE_BUSY"))).toBe(true);
    expect(isEnvironmentalFailure(new OtherDriverSqliteError("dup", "SQLITE_CONSTRAINT_PRIMARYKEY"))).toBe(false);
    expect(isEnvironmentalFailure(new Database.SqliteError("busy", "SQLITE_BUSY"))).toBe(true);
    expect(isEnvironmentalFailure(new Database.SqliteError("full", "SQLITE_FULL"))).toBe(true);
    expect(isEnvironmentalFailure(new Database.SqliteError("dup", "SQLITE_CONSTRAINT_UNIQUE"))).toBe(false);
    expect(isEnvironmentalFailure(new Error("Payload hash mismatch"))).toBe(false);
  });

  it("aborts without advancing the watermark when the local database fails", async () => {
    const hub = node("hub");
    const target = node("target");
    const event = wroteNote(hub, true);
    const peerId = addPeer(target.db, hub.nodeId, event.publicKey!);
    const realPrepare = target.db.prepare.bind(target.db);
    // Simulate a locked database at the moment the event would be stored.
    target.db.prepare = ((sql: string) => {
      if (sql.startsWith("INSERT INTO events")) throw new Database.SqliteError("database is locked", "SQLITE_BUSY");
      return realPrepare(sql);
    }) as typeof target.db.prepare;

    await expect(pull(target, peerId, [event])).rejects.toThrow(/database is locked/);
    target.db.prepare = realPrepare;
    expect(throughSeq(target, hub.nodeId)).toBeUndefined();
    expect(rejections(target)).toEqual([]);
  });

  it("does not keep an item for an entry already purged here", async () => {
    const hub = node("hub");
    const target = node("target");
    const peerId = addPeer(target.db, hub.nodeId, wroteNote(hub, true).publicKey!);
    const local = writeEntry(ctx(target, false), { scope: "sample-app", kind: "note", title: "Local", body: "Body text", request_id: newId() });
    const entryId = (target.db.prepare("SELECT entry_id FROM entries LIMIT 1").get() as { entry_id: string }).entry_id;
    purgeEntry(ctx(target, false), local.ref, "Leaked a credential.");
    const forged = { ...wroteNote(hub, true, "Late edit"), entryId, payload: { body: "Leaked again" } };

    await expect(pull(target, peerId, [forged])).resolves.toMatchObject({ rejected: 1 });
    expect(rejections(target)).toEqual([expect.objectContaining({ event_id: forged.eventId, raw: null })]);
  });

  it("purging an entry deletes its rejection rows, so a stored payload never outlives the purge", () => {
    const target = node("target");
    const created = writeEntry(ctx(target, false), { scope: "sample-app", kind: "note", title: "Local", body: "Body text", request_id: newId() });
    const entryId = (target.db.prepare("SELECT entry_id FROM entries LIMIT 1").get() as { entry_id: string }).entry_id;
    target.db.prepare(
      "INSERT INTO sync_rejections (peer_node, event_id, entry_id, raw, reason, first_rejected_at, last_rejected_at) VALUES ('hub', 'e1', ?, '{}', 'r', 't', 't')",
    ).run(entryId);

    purgeEntry(ctx(target, false), created.ref, "Leaked a credential.");
    expect(rejections(target)).toEqual([]);
  });

  it("property (RP-AC-5): with malformed events mixed into the stream, one pull converges and records exactly the malformed ids", async () => {
    const hub = node("hub");
    const third = node("third");
    const valid = [wroteNote(hub, true), wroteNote(hub, true), wroteNote(third, true), wroteNote(third, true)];
    const keys = new Map(valid.map((e) => [e.originNode, e.publicKey!]));
    const receiver = () => {
      const target = node("target");
      const peerId = addPeer(target.db, hub.nodeId, keys.get(hub.nodeId)!);
      pinPublicKey(target.db, third.nodeId, keys.get(third.nodeId)!, 0);
      return { target, peerId };
    };
    // Malformed events of three kinds, each on its own entry so none shares an id with a valid one.
    const malformed: ((target: Node) => WireEvent)[] = [
      () => tampered(wroteNote(hub, true, "Tampered")),
      () => tampered(wroteNote(third, true, "Tampered")),
      (target) => unsignedGrant(target, hub.nodeId),
      () => ({ ...wroteNote(hub, true, "Stripped"), payloadStripped: true }),
      () => ({ ...wroteNote(third, true, "Stripped"), payloadStripped: true }),
    ];
    const snapshot = (n: Node) => ({
      events: n.db.prepare("SELECT event_id FROM events ORDER BY event_id").all(),
      entries: n.db.prepare("SELECT entry_id, title, body, content_rev, status FROM entries ORDER BY entry_id").all(),
      pools: n.db.prepare("SELECT name FROM pools").all(),
    });

    const reference = receiver();
    await pull(reference.target, reference.peerId, valid);
    const expected = snapshot(reference.target);
    expect(expected.events).toHaveLength(valid.length);

    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(valid, { minLength: valid.length, maxLength: valid.length }),
        fc.array(fc.tuple(fc.nat({ max: valid.length }), fc.nat({ max: malformed.length - 1 })), { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 1, max: valid.length + 3 }),
        async (order, inserts, pageSize) => {
          const { target, peerId } = receiver();
          const delivered: WireEvent[] = [...order];
          const bad: string[] = [];
          for (const [at, kind] of inserts) {
            const event = malformed[kind]!(target);
            bad.push(event.eventId);
            delivered.splice(Math.min(at, delivered.length), 0, event);
          }

          await expect(pull(target, peerId, delivered, pageSize)).resolves.toMatchObject({ rejected: bad.length });
          expect(snapshot(target)).toEqual(expected);
          expect(rejections(target).map((r) => r.event_id)).toEqual([...bad].sort());
        },
      ),
      { numRuns: 25 },
    );
  });
});
