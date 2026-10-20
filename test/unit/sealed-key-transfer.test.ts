import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { CtxdError } from "../../src/core/errors.js";
import { openDatabase } from "../../src/store/db.js";
import { FileEventKeyProvider } from "../../src/security/event-signatures.js";
import { FileEncryptionKeyProvider, signEncryptionPrekey, type EncryptionKeyPair } from "../../src/sealed/encryptionKeys.js";
import { TestKeyProvider } from "../../src/sealed/key-provider.js";
import { approveKeyTransfer, completeKeyTransfer, fetchWrappedKey, requestKeyTransfer, type SignedPrekey } from "../../src/sealed/keyTransfer.js";

/**
 * W2: two local nodes (two real, separate databases, each with its own Ed25519 and X25519
 * identity -- the same "two local servers" the task's exit criterion asks for, simulated as two
 * database instances the way test/unit/sync-partition-property.test.ts already tests multi-node
 * sync behavior) exercise the full request -> approve -> fetch -> complete flow, plus every
 * refusal path, against the test key provider.
 */

interface SimNode {
  db: Database.Database;
  nodeId: string;
  signingKeys: ReturnType<FileEventKeyProvider["keyPair"]>;
  encKeys: EncryptionKeyPair;
}

function now(): string {
  return new Date().toISOString();
}

function makeNode(): SimNode {
  const dir = mkdtempSync(join(tmpdir(), "ctxd-key-transfer-"));
  const dbPath = join(dir, "ctxd.db");
  const db = openDatabase(dbPath, { create: true });
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, ?, 'home', ?)").run(nodeId, nodeId, now());
  const signingKeys = new FileEventKeyProvider(dbPath).keyPair(nodeId);
  const encKeys = new FileEncryptionKeyProvider(dbPath).keyPair(nodeId);
  return { db, nodeId, signingKeys, encKeys };
}

/** Records `peer`'s Ed25519 identity as an already-trusted, un-revoked enrollment on `self`'s side, matching what a real M6 peer-enrollment handshake produces. */
function trustPeer(self: SimNode, peer: SimNode): void {
  self.db
    .prepare(
      "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at, remote_node_id, remote_public_key) VALUES (?, ?, 'https://peer.example/sync', 'home', 'h', ?, ?, ?)",
    )
    .run(newId(), peer.nodeId, now(), peer.nodeId, peer.signingKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
}

function sealedPool(source: SimNode, name: string): { poolId: string; key: Buffer } {
  const poolId = newId();
  source.db.prepare("INSERT INTO pools (pool_id, name, storage, created_at) VALUES (?, ?, 'sealed', ?)").run(poolId, name, now());
  return { poolId, key: randomBytes(32) };
}

function presentPrekey(node: SimNode): SignedPrekey {
  return { nodeId: node.nodeId, ...signEncryptionPrekey(node.nodeId, node.encKeys, node.signingKeys.privateKey) };
}

describe("sealed pool key transfer: happy path", () => {
  it("source unlocks only after an approved transfer, and the recipient ends up with the real key", () => {
    const source = makeNode();
    const requester = makeNode();
    trustPeer(source, requester); // source already trusts requester as an enrolled peer
    trustPeer(requester, source); // and vice versa
    const pool = sealedPool(source, "pool-dev");

    const requesterPrekey = presentPrekey(requester);
    const { transferId, sourcePrekey } = requestKeyTransfer(source.db, pool.poolId, requesterPrekey, source.nodeId, source.signingKeys.privateKey, source.encKeys);

    const approval = approveKeyTransfer(source.db, transferId, source.encKeys, pool.key);
    const wrapped = fetchWrappedKey(source.db, transferId);

    const completion = completeKeyTransfer(transferId, requester.encKeys, sourcePrekey, wrapped);
    expect(completion.confirmationCode).toBe(approval.confirmationCode); // both sides saw the same code
    expect(completion.poolKey).toEqual(pool.key); // the recipient really unwrapped the real key

    const requesterKeys = new TestKeyProvider();
    requesterKeys.store(pool.poolId, completion.poolKey);
    expect(requesterKeys.get(pool.poolId)).toEqual(pool.key);
  });
});

describe("sealed pool key transfer: refusal paths", () => {
  it("refuses a request from an unknown node (never peered)", () => {
    const source = makeNode();
    const stranger = makeNode(); // never trusted by source
    const pool = sealedPool(source, "pool-dev");

    const prekey = presentPrekey(stranger);
    expect(() => requestKeyTransfer(source.db, pool.poolId, prekey, source.nodeId, source.signingKeys.privateKey, source.encKeys)).toThrow(CtxdError);
  });

  it("refuses a request from a revoked peer", () => {
    const source = makeNode();
    const requester = makeNode();
    trustPeer(source, requester);
    source.db.prepare("UPDATE peers SET revoked_at = ? WHERE remote_node_id = ?").run(now(), requester.nodeId);
    const pool = sealedPool(source, "pool-dev");

    const prekey = presentPrekey(requester);
    expect(() => requestKeyTransfer(source.db, pool.poolId, prekey, source.nodeId, source.signingKeys.privateKey, source.encKeys)).toThrow(CtxdError);
  });

  it("refuses a request with a prekey not actually signed by the claimed node (substitution)", () => {
    const source = makeNode();
    const requester = makeNode();
    const attacker = makeNode();
    trustPeer(source, requester);
    const pool = sealedPool(source, "pool-dev");

    // The payload claims to be from `requester` but the signature is from `attacker`'s key.
    const forged: SignedPrekey = { nodeId: requester.nodeId, ...signEncryptionPrekey(requester.nodeId, requester.encKeys, attacker.signingKeys.privateKey) };
    expect(() => requestKeyTransfer(source.db, pool.poolId, forged, source.nodeId, source.signingKeys.privateKey, source.encKeys)).toThrow(CtxdError);
  });

  it("refuses fetching before approval", () => {
    const source = makeNode();
    const requester = makeNode();
    trustPeer(source, requester);
    const pool = sealedPool(source, "pool-dev");

    const { transferId } = requestKeyTransfer(source.db, pool.poolId, presentPrekey(requester), source.nodeId, source.signingKeys.privateKey, source.encKeys);
    expect(() => fetchWrappedKey(source.db, transferId)).toThrow(CtxdError);
  });

  it("refuses approving an unknown transfer id", () => {
    const source = makeNode();
    const pool = sealedPool(source, "pool-dev");
    expect(() => approveKeyTransfer(source.db, newId(), source.encKeys, pool.key)).toThrow(CtxdError);
  });

  it("refuses a replayed fetch after the transfer was already consumed", () => {
    const source = makeNode();
    const requester = makeNode();
    trustPeer(source, requester);
    const pool = sealedPool(source, "pool-dev");

    const { transferId } = requestKeyTransfer(source.db, pool.poolId, presentPrekey(requester), source.nodeId, source.signingKeys.privateKey, source.encKeys);
    approveKeyTransfer(source.db, transferId, source.encKeys, pool.key);
    fetchWrappedKey(source.db, transferId); // first fetch succeeds
    expect(() => fetchWrappedKey(source.db, transferId)).toThrow(CtxdError); // replay refused
  });

  it("refuses approving an expired transfer, and a subsequent fetch too", () => {
    const source = makeNode();
    const requester = makeNode();
    trustPeer(source, requester);
    const pool = sealedPool(source, "pool-dev");

    const { transferId } = requestKeyTransfer(source.db, pool.poolId, presentPrekey(requester), source.nodeId, source.signingKeys.privateKey, source.encKeys);
    source.db.prepare("UPDATE sealed_key_transfers SET expires_at = ? WHERE transfer_id = ?").run(new Date(Date.now() - 60_000).toISOString(), transferId);

    expect(() => approveKeyTransfer(source.db, transferId, source.encKeys, pool.key)).toThrow(CtxdError);
    expect(() => fetchWrappedKey(source.db, transferId)).toThrow(CtxdError); // never became approved
  });

  it("refuses enrolling for a pool that is not sealed", () => {
    const source = makeNode();
    const requester = makeNode();
    trustPeer(source, requester);
    const poolId = newId();
    source.db.prepare("INSERT INTO pools (pool_id, name, storage, created_at) VALUES (?, 'pool-ops', 'shared', ?)").run(poolId, now());

    expect(() => requestKeyTransfer(source.db, poolId, presentPrekey(requester), source.nodeId, source.signingKeys.privateKey, source.encKeys)).toThrow(CtxdError);
  });
});
