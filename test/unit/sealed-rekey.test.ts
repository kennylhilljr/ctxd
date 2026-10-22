import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { encodeHlc, HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { TestKeyProvider } from "../../src/sealed/key-provider.js";
import { SealedPoolStore, TestDatabaseProvider } from "../../src/sealed/store.js";
import { openDatabase } from "../../src/store/db.js";
import { appendAclEvent } from "../../src/store/acl.js";
import { applyEvent } from "../../src/store/materialize.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";

/**
 * `ctxd pool rekey` (W7's approved follow-up to W2). Rotation is tested against the test key and
 * database providers, so nothing here touches a real Keychain or a real SQLCipher file;
 * `TestDatabaseProvider.rekeyCalls` is how a test observes that the re-encryption step ran and
 * with which key, since the test database is never actually encrypted.
 */

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  db: Database.Database;
  nodeId: string;
  humanId: string;
  poolId: string;
  keys: TestKeyProvider;
  databases: TestDatabaseProvider;
  store: SealedPoolStore;
  ctx: WriteContext;
}

/** A sealed pool with this node enrolled, matching what `ctxd pool seal` leaves behind. */
function sealedFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ctxd-rekey-"));
  scratch.push(root);
  const db = openDatabase(join(root, "ctxd.db"), { create: true });
  const nodeId = newId();
  const humanId = newId();
  const scopeId = newId();
  const poolId = newId();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'node-a', 'home', ?)").run(nodeId, now);
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now);
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'private-a', ?)").run(scopeId, now);
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES (?, 'pool-private', ?)").run(poolId, now);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, 'write')").run(poolId, scopeId);
  const ctx: WriteContext = { db, clock: new HlcClock(nodeId), nodeId, clientId: humanId };
  writeEntry(ctx, { scope: "private-a", kind: "note", title: "Sealed note", body: "Sensitive body", request_id: newId() } as never);

  const keys = new TestKeyProvider();
  const databases = new TestDatabaseProvider();
  const store = new SealedPoolStore(db, root, keys, databases, 1);
  const sealedFile = store.seal(poolId, nodeId);
  // `seal()` leaves the pools.storage/sealed_file columns to the acl event that normally follows
  // it, and records this node's own enrollment the same way (test/unit/sealed.test.ts does this).
  db.prepare("UPDATE pools SET storage = 'sealed', sealed_file = ? WHERE pool_id = ?").run(sealedFile, poolId);
  db.prepare("INSERT INTO pool_enrollments (pool_id, node_id, enrolled_at) VALUES (?, ?, ?)").run(poolId, nodeId, now);

  return { root, db, nodeId, humanId, poolId, keys, databases, store, ctx };
}

describe("SealedPoolStore.rekey", () => {
  it("refuses a pool that is not sealed, changing nothing", () => {
    const f = sealedFixture();
    f.db.prepare("UPDATE pools SET storage = 'shared' WHERE pool_id = ?").run(f.poolId);
    const before = f.keys.get(f.poolId);

    expect(() => f.store.rekey(f.poolId, f.nodeId)).toThrow(/not sealed/);
    expect(f.keys.get(f.poolId)).toEqual(before);
    expect(f.databases.rekeyCalls).toHaveLength(0);
  });

  it("re-encrypts under a fresh key, commits it, and leaves no staging entry behind", () => {
    const f = sealedFixture();
    const before = f.keys.get(f.poolId);

    f.store.rekey(f.poolId, f.nodeId);

    const after = f.keys.get(f.poolId);
    expect(after).not.toEqual(before);
    expect(after).toHaveLength(32);
    // The file was re-encrypted under exactly the key that was then committed, not some third one.
    expect(f.databases.rekeyCalls).toHaveLength(1);
    expect(f.databases.rekeyCalls[0]).toEqual(after);
    expect(f.keys.keys.has(SealedPoolStore.stagingKeyId(f.poolId))).toBe(false);
  });

  it("still unlocks afterwards, with the rotated key", () => {
    const f = sealedFixture();
    f.store.rekey(f.poolId, f.nodeId);

    // withPool -> unlock -> keys.get(poolId): throws if the committed key were wrong or missing.
    const count = f.store.withPool(f.poolId, (sealed) => (sealed.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n);
    expect(count).toBe(1);
    f.store.close();
  });

  it("reports the other enrolled nodes, never this one, and deletes no rows itself", () => {
    const f = sealedFixture();
    const now = new Date().toISOString();
    f.db.prepare("INSERT INTO pool_enrollments (pool_id, node_id, enrolled_at) VALUES (?, 'node-b', ?)").run(f.poolId, now);
    f.db.prepare("INSERT INTO pool_enrollments (pool_id, node_id, enrolled_at) VALUES (?, 'node-c', ?)").run(f.poolId, now);

    const dropped = f.store.rekey(f.poolId, f.nodeId);
    expect(dropped).toEqual(["node-b", "node-c"]);
    expect(dropped).not.toContain(f.nodeId);
    // ADR 0002: materialized access state only changes through an event, so the rows are still
    // here until the caller emits pool_unenroll.
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM pool_enrollments WHERE pool_id = ?").get(f.poolId) as { n: number }).n).toBe(3);
  });

  it("keeps the old key in place when the irreversible step itself fails", () => {
    const f = sealedFixture();
    const before = f.keys.get(f.poolId);
    f.databases.rekey = () => {
      throw new Error("simulated SQLCipher failure");
    };

    expect(() => f.store.rekey(f.poolId, f.nodeId)).toThrow(/simulated SQLCipher failure/);
    // The file was never re-encrypted, so the old key must still be the pool's key, and the
    // staging entry must be gone rather than left to confuse a later recovery.
    expect(f.keys.get(f.poolId)).toEqual(before);
    expect(f.keys.keys.has(SealedPoolStore.stagingKeyId(f.poolId))).toBe(false);
  });

  it("names the staging id when the file was re-encrypted but the new key could not be committed", () => {
    const f = sealedFixture();
    f.keys.store = (poolId: string, key: Buffer) => {
      // Staging succeeds; promoting to the pool's own id is what fails, which is the one window
      // that leaves a re-encrypted file whose key is not yet where `unlock` looks for it.
      if (poolId === f.poolId) throw new Error("keychain write refused");
      TestKeyProvider.prototype.store.call(f.keys, poolId, key);
    };

    expect(() => f.store.rekey(f.poolId, f.nodeId)).toThrow(/still stored as "[^"]*rekey-pending"/);
    expect(f.keys.keys.has(SealedPoolStore.stagingKeyId(f.poolId))).toBe(true);
  });
});

describe("pool_unenroll acl event", () => {
  it("deletes the enrollment a pool_enroll event created", () => {
    const f = sealedFixture();
    appendAclEvent(f.ctx, f.poolId, { action: "pool_enroll", node_id: "node-b" });
    expect(f.db.prepare("SELECT 1 FROM pool_enrollments WHERE pool_id = ? AND node_id = 'node-b'").get(f.poolId)).toBeDefined();

    appendAclEvent(f.ctx, f.poolId, { action: "pool_unenroll", node_id: "node-b" });
    expect(f.db.prepare("SELECT 1 FROM pool_enrollments WHERE pool_id = ? AND node_id = 'node-b'").get(f.poolId)).toBeUndefined();
  });

  it("is HLC-guarded, so an older enroll arriving late never resurrects a rotated-out node", () => {
    const f = sealedFixture();
    // Built explicitly a minute in the past rather than from a second clock: a fresh HlcClock
    // ticks at the current millisecond, which can tie with the unenroll's own HLC, and the guard
    // accepts ties deliberately (see aclGuardPasses). A tie would prove nothing either way.
    const staleHlc = encodeHlc({ physical: Date.now() - 60_000, counter: 0, node: f.nodeId });
    appendAclEvent(f.ctx, f.poolId, { action: "pool_unenroll", node_id: "node-b" });

    const eventId = newId();
    applyEvent(f.db, {
      eventId,
      scopeId: "_system",
      entryId: f.poolId,
      op: "acl",
      part: "meta",
      rev: `1-${eventId}`,
      clientId: f.humanId,
      hlc: staleHlc,
      payload: { action: "pool_enroll", node_id: "node-b" },
      prev: null,
    });

    expect(f.db.prepare("SELECT 1 FROM pool_enrollments WHERE pool_id = ? AND node_id = 'node-b'").get(f.poolId)).toBeUndefined();
  });

  it("does not make unenroll win unconditionally: a later enroll re-enrolls the node", () => {
    const f = sealedFixture();
    appendAclEvent(f.ctx, f.poolId, { action: "pool_unenroll", node_id: "node-b" });
    appendAclEvent(f.ctx, f.poolId, { action: "pool_enroll", node_id: "node-b" });
    expect(f.db.prepare("SELECT 1 FROM pool_enrollments WHERE pool_id = ? AND node_id = 'node-b'").get(f.poolId)).toBeDefined();
  });
});
