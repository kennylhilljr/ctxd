import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { purgeEntry } from "../../src/store/purge.js";
import { rebuild } from "../../src/store/rebuild.js";
import { applyEvent, toWireEvent, type EventRow } from "../../src/sync/apply.js";
import { pinPublicKey } from "../../src/security/event-signatures.js";

function fixture() {
  const db = openDatabase(":memory:", { create: true });
  const nodeId = newId();
  const humanId = newId();
  const scopeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'node-a', 'home', ?)").run(nodeId, new Date().toISOString());
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), new Date().toISOString());
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(scopeId, new Date().toISOString());
  return { db, nodeId, humanId, scopeId };
}

function ctx(f: ReturnType<typeof fixture>, signed: boolean): WriteContext {
  return { db: f.db, clock: new HlcClock(f.nodeId), nodeId: f.nodeId, clientId: f.humanId, flags: new Map([["signed_events", signed]]) };
}

function firstWire(f: ReturnType<typeof fixture>) {
  return toWireEvent(f.db.prepare("SELECT * FROM events ORDER BY origin_seq LIMIT 1").get() as EventRow);
}

function trustWire(db: ReturnType<typeof fixture>["db"], wire: ReturnType<typeof firstWire>): void {
  if (!wire.publicKey) throw new Error("expected signed wire event");
  pinPublicKey(db, wire.originNode, wire.publicKey, wire.originSeq);
}

describe("signed events (Spec v9 section 7.7)", () => {
  it("signs new events only while the flag is on", () => {
    const on = fixture();
    writeEntry(ctx(on, true), { scope: "sample-app", kind: "note", title: "Signed", body: "Signed body", request_id: newId() });
    expect(on.db.prepare("SELECT payload_hash, signature, public_key FROM events").get()).toMatchObject({
      payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/), signature: expect.any(String), public_key: expect.any(String),
    });

    const off = fixture();
    writeEntry(ctx(off, false), { scope: "sample-app", kind: "note", title: "Unsigned", body: "Unsigned body", request_id: newId() });
    expect(off.db.prepare("SELECT payload_hash, signature, public_key FROM events").get()).toEqual({ payload_hash: null, signature: null, public_key: null });
  });

  it("verifies a signature on apply even when local signing is off, and rejects tampering", () => {
    const source = fixture();
    writeEntry(ctx(source, true), { scope: "sample-app", kind: "note", title: "Signed", body: "Original body", request_id: newId() });
    const wire = firstWire(source);

    const target = fixture();
    target.db.prepare("DELETE FROM scopes").run();
    target.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(source.scopeId, new Date().toISOString());
    trustWire(target.db, wire);
    expect(applyEvent(target.db, wire).outcome).toBe("fast-forward");

    const tampered = fixture();
    tampered.db.prepare("DELETE FROM scopes").run();
    tampered.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(source.scopeId, new Date().toISOString());
    trustWire(tampered.db, wire);
    expect(() => applyEvent(tampered.db, { ...wire, payload: { ...wire.payload, body: "Changed" } })).toThrow(/Payload hash mismatch/);
  });

  it("retains verifiable hashes and signatures after purge and rebuild", () => {
    const f = fixture();
    const result = writeEntry(ctx(f, true), { scope: "sample-app", kind: "note", title: "Erase", body: "Erase this body", request_id: newId() });
    if ("held" in result) throw new Error("unexpected held write");
    purgeEntry(ctx(f, true), result.ref, "test purge");
    const before = f.db.prepare("SELECT payload_hash, signature, public_key FROM events WHERE event_id = (SELECT event_id FROM events ORDER BY origin_seq LIMIT 1)").get();
    rebuild(f.db);
    expect(f.db.prepare("SELECT payload_hash, signature, public_key FROM events WHERE event_id = (SELECT event_id FROM events ORDER BY origin_seq LIMIT 1)").get()).toEqual(before);
  });

  it("verifies a signed raw late arrival before stripping it after purge", () => {
    const source = fixture();
    const created = writeEntry(ctx(source, true), { scope: "sample-app", kind: "note", title: "Late", body: "Raw signed body", request_id: newId() });
    if ("held" in created) throw new Error("unexpected held write");
    const wire = firstWire(source);

    const target = fixture();
    target.db.prepare("DELETE FROM scopes").run();
    target.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(source.scopeId, new Date().toISOString());
    trustWire(target.db, wire);
    applyEvent(target.db, wire);
    purgeEntry(ctx(target, true), created.id, "remove before replay");
    target.db.prepare("DELETE FROM events WHERE event_id = ?").run(wire.eventId);
    expect(applyEvent(target.db, wire).outcome).toBe("purge-stripped");
    expect(target.db.prepare("SELECT payload, payload_hash, signature, public_key FROM events WHERE event_id = ?").get(wire.eventId)).toMatchObject({
      payload: JSON.stringify({ purged: true }), payload_hash: wire.payloadHash, signature: wire.signature, public_key: wire.publicKey,
    });
    expect(() => applyEvent(target.db, { ...wire, eventId: newId(), payload: { ...wire.payload, body: "tampered" } })).toThrow(/Payload hash mismatch/);
  });

  it("binds every immutable envelope field and both retained hashes", () => {
    const source = fixture();
    writeEntry(ctx(source, true), { scope: "sample-app", kind: "note", title: "Envelope", body: "Signed body", request_id: newId() });
    const wire = firstWire(source);
    const mutations: Array<[string, (value: typeof wire) => typeof wire]> = [
      ["eventId", (v) => ({ ...v, eventId: newId() })], ["schemaVersion", (v) => ({ ...v, schemaVersion: v.schemaVersion + 1 })],
      ["originNode", (v) => ({ ...v, originNode: newId() })],
      ["originSeq", (v) => ({ ...v, originSeq: v.originSeq + 1 })], ["hlc", (v) => ({ ...v, hlc: `${v.hlc}x` })],
      ["scopeId", (v) => ({ ...v, scopeId: newId() })], ["entryId", (v) => ({ ...v, entryId: newId() })],
      ["op", (v) => ({ ...v, op: "update" })], ["part", (v) => ({ ...v, part: "status" })],
      ["parentRevs", (v) => ({ ...v, parentRevs: [newId()] })], ["rev", (v) => ({ ...v, rev: newId() })],
      ["clientId", (v) => ({ ...v, clientId: newId() })], ["sessionRef", (v) => ({ ...v, sessionRef: "session-x" })],
      ["requestId", (v) => ({ ...v, requestId: newId() })], ["requestHash", (v) => ({ ...v, requestHash: "f".repeat(64) })],
      ["payload", (v) => ({ ...v, payload: { ...v.payload, body: "changed" } })], ["prev", (v) => ({ ...v, prev: { changed: true } })],
      ["payloadHash", (v) => ({ ...v, payloadHash: "a".repeat(64) })], ["prevHash", (v) => ({ ...v, prevHash: "b".repeat(64) })],
    ];
    for (const [field, mutate] of mutations) {
      const target = fixture();
      target.db.prepare("DELETE FROM scopes").run();
      target.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(source.scopeId, new Date().toISOString());
      const changed = mutate(wire);
      if (field === "originNode") pinPublicKey(target.db, changed.originNode, wire.publicKey!, wire.originSeq);
      else trustWire(target.db, wire);
      expect(() => applyEvent(target.db, changed), field).toThrow();
    }
  });

  it("rejects unsigned events at and after a pinned origin cutoff, but deduplicates before inspecting duplicate metadata", () => {
    const source = fixture();
    writeEntry(ctx(source, true), { scope: "sample-app", kind: "note", title: "Pinned", body: "Body", request_id: newId() });
    const wire = firstWire(source);
    const target = fixture();
    target.db.prepare("DELETE FROM scopes").run();
    target.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(source.scopeId, new Date().toISOString());
    trustWire(target.db, wire);
    expect(applyEvent(target.db, wire).outcome).toBe("fast-forward");
    expect(applyEvent(target.db, { ...wire, signature: null, publicKey: null, payloadHash: null, prevHash: null }).outcome).toBe("already-known");
    expect(() => applyEvent(target.db, { ...wire, eventId: newId(), originSeq: wire.originSeq + 1, signature: null, publicKey: null, payloadHash: null, prevHash: null })).toThrow(/signature cutoff/);
  });
});
