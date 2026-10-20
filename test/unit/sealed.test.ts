import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { decryptSealed, encryptSealed } from "../../src/sealed/crypto.js";
import { TestKeyProvider } from "../../src/sealed/key-provider.js";
import { createSealedPurgeReplay, SealedPoolStore, TestDatabaseProvider } from "../../src/sealed/store.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry } from "../../src/store/write.js";
import { servePull } from "../../src/sync/pull.js";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctxd-sealed-")); scratch.push(root);
  const db = openDatabase(join(root, "ctxd.db"), { create: true });
  const nodeId = newId(); const clientId = newId(); const scopeId = newId(); const poolId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'node-a', 'home', ?)").run(nodeId, new Date().toISOString());
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(clientId, nodeId, newId(), new Date().toISOString());
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'private-a', ?)").run(scopeId, new Date().toISOString());
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES (?, 'pool-private', ?)").run(poolId, new Date().toISOString());
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, 'write')").run(poolId, scopeId);
  writeEntry({ db, clock: new HlcClock(nodeId), nodeId, clientId }, { scope: "private-a", kind: "note", title: "Sealed note", body: "Sensitive body", request_id: newId() } as never);
  const keys = new TestKeyProvider();
  const store = new SealedPoolStore(db, root, keys, new TestDatabaseProvider(), 1);
  return { root, db, nodeId, humanId: clientId, poolId, keys, store };
}

describe("sealed pools (Spec v9 section 10.6)", () => {
  it("refuses to enroll a node for a pool that is not sealed", () => {
    const f = fixture(); // the fixture's pool defaults to 'shared' storage; store.seal() is never called
    expect(() => f.store.enroll(f.poolId, "node-b", Buffer.alloc(32, 1))).toThrow(/not sealed/);
    expect(f.db.prepare("SELECT 1 FROM pool_enrollments WHERE pool_id = ? AND node_id = 'node-b'").get(f.poolId)).toBeUndefined();
  });

  it("enroll (W2) installs the received key and records the enrollment, once the pool is actually sealed", () => {
    const f = fixture();
    const sealedFile = f.store.seal(f.poolId, f.nodeId);
    // store.seal() moves the data but, same as the live CLI's own "seal" case, leaves the
    // pools.storage/sealed_file columns to the acl event that normally follows; set them
    // directly here rather than pulling the whole acl-event machinery into this fixture.
    f.db.prepare("UPDATE pools SET storage = 'sealed', sealed_file = ? WHERE pool_id = ?").run(sealedFile, f.poolId);
    const receivedKey = Buffer.alloc(32, 2);

    f.store.enroll(f.poolId, "node-b", receivedKey);

    expect(f.keys.get(f.poolId)).toEqual(receivedKey);
    expect(f.db.prepare("SELECT 1 FROM pool_enrollments WHERE pool_id = ? AND node_id = 'node-b'").get(f.poolId)).toBeDefined();
  });
  it("round trips XChaCha20-Poly1305 envelopes and authenticates event ids", () => {
    const key = Buffer.alloc(32, 7);
    const envelope = encryptSealed(Buffer.from("payload"), key, "event-a");
    expect(decryptSealed(envelope, key, "event-a").toString()).toBe("payload");
    expect(() => decryptSealed(envelope, key, "event-b")).toThrow();
  });

  it("round trips arbitrary replicated payloads", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 4096 }), fc.string(), (bytes, eventId) => {
      const key = Buffer.alloc(32, 11);
      const envelope = encryptSealed(Buffer.from(bytes), key, eventId);
      expect(decryptSealed(envelope, key, eventId)).toEqual(Buffer.from(bytes));
    }), { numRuns: 100 });
  });

  it("routes each unlocked request to the sealed database without copying plaintext into main", () => {
    const f = fixture();
    const relative = f.store.seal(f.poolId, f.nodeId);
    f.db.prepare("UPDATE pools SET storage = 'sealed', sealed_file = ? WHERE pool_id = ?").run(relative, f.poolId);
    f.db.prepare("INSERT INTO pool_enrollments (pool_id, node_id, enrolled_at) VALUES (?, ?, ?)").run(f.poolId, f.nodeId, new Date().toISOString());
    expect(relative).toBe(`sealed/${f.poolId}.db`);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
    expect(readFileSync(join(f.root, relative)).length).toBeGreaterThan(0);
    expect(f.db.prepare("SELECT storage FROM pools WHERE pool_id = ?").get(f.poolId)).toEqual({ storage: "sealed" });
    expect(f.db.prepare("SELECT node_id FROM pool_enrollments WHERE pool_id = ?").get(f.poolId)).toEqual({ node_id: f.nodeId });

    f.store.unlock(f.poolId);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
    expect(f.store.withPool(f.poolId, (db) => db.prepare("SELECT title, body FROM entries").get())).toEqual({ title: "Sealed note", body: "Sensitive body" });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
    f.store.lock(f.poolId);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
  });

  it("allocates one origin sequence across shared and sealed databases", () => {
    const f = fixture();
    const relative = f.store.seal(f.poolId, f.nodeId);
    f.db.prepare("UPDATE pools SET storage = 'sealed', sealed_file = ? WHERE pool_id = ?").run(relative, f.poolId);
    f.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(newId(), new Date().toISOString());
    writeEntry({ db: f.db, clock: new HlcClock(f.nodeId), nodeId: f.nodeId, clientId: f.humanId }, { scope: "sample-app", kind: "note", title: "Shared", body: "Shared body", request_id: newId() } as never);
    f.store.withPool(f.poolId, (db) => {
      writeEntry({ db, clock: new HlcClock(f.nodeId), nodeId: f.nodeId, clientId: f.humanId }, { scope: "private-a", kind: "note", title: "Second sealed", body: "Body", request_id: newId() } as never);
    });
    const shared = f.db.prepare("SELECT origin_seq FROM events ORDER BY origin_seq DESC LIMIT 1").get() as { origin_seq: number };
    const sealed = f.store.withPool(f.poolId, (db) => db.prepare("SELECT origin_seq FROM events ORDER BY origin_seq DESC LIMIT 1").get() as { origin_seq: number });
    expect(shared.origin_seq).not.toBe(sealed.origin_seq);
  });

  it("replays queued purges inside the sealed store and removes the queue only after success", () => {
    const f = fixture();
    const relative = f.store.seal(f.poolId, f.nodeId);
    f.db.prepare("UPDATE pools SET storage = 'sealed', sealed_file = ? WHERE pool_id = ?").run(relative, f.poolId);
    const entryId = f.store.withPool(f.poolId, (db) => (db.prepare("SELECT entry_id FROM entries").get() as { entry_id: string }).entry_id);
    f.store.lock(f.poolId);
    f.store.queuePurge(f.poolId, entryId);

    f.store.close();
    const replayingStore = new SealedPoolStore(
      f.db, f.root, f.keys, new TestDatabaseProvider(), 1, createSealedPurgeReplay(f.nodeId, f.humanId),
    );
    replayingStore.unlock(f.poolId);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM sealed_purge_queue").get()).toEqual({ n: 0 });
    expect(replayingStore.withPool(f.poolId, (db) => db.prepare("SELECT title, body FROM entries WHERE entry_id = ?").get(entryId))).toEqual({ title: "[purged]", body: "" });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
  });

  it("rejects unlock when the key provider is locked", () => {
    const f = fixture();
    const relative = f.store.seal(f.poolId, f.nodeId);
    f.db.prepare("UPDATE pools SET storage = 'sealed', sealed_file = ? WHERE pool_id = ?").run(relative, f.poolId);
    f.keys.remove(f.poolId);
    expect(() => f.store.unlock(f.poolId)).toThrow(/locked/);
  });

  it("serves sealed events only to enrolled nodes and encrypts them in transit", () => {
    const f = fixture();
    const relative = f.store.seal(f.poolId, f.nodeId);
    f.db.prepare("UPDATE pools SET storage = 'sealed', sealed_file = ? WHERE pool_id = ?").run(relative, f.poolId);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    const denied = servePull(f.db, "home", { node: "node-b", vector: {}, limit: 100 }, f.keys, f.store);
    expect(denied.events).toEqual([]);
    f.db.prepare("INSERT INTO pool_enrollments (pool_id, node_id, enrolled_at) VALUES (?, 'node-b', ?)").run(f.poolId, new Date().toISOString());
    const allowed = servePull(f.db, "home", { node: "node-b", vector: {}, limit: 100 }, f.keys, f.store);
    expect(allowed.events).toHaveLength(1);
    expect(allowed.events[0]).toMatchObject({ sealed: true, pool_id: f.poolId });
    expect(JSON.stringify(allowed.events[0])).not.toContain("Sensitive body");
  });
});
