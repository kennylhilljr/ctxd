import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/hash.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { startSyncServer, type RunningSyncServer } from "../../src/server/sync.js";
import { FileEventKeyProvider } from "../../src/security/event-signatures.js";
import { FileEncryptionKeyProvider, signEncryptionPrekey, type EncryptionKeyPair } from "../../src/sealed/encryptionKeys.js";
import { approveKeyTransfer, type SignedPrekey } from "../../src/sealed/keyTransfer.js";
import { TestKeyProvider } from "../../src/sealed/key-provider.js";

/**
 * W2's "two local servers" exit criterion, over real HTTP: `startSyncServer` is a plain,
 * self-contained function, safe to call directly in a test (unlike `ctxd server`'s own `run()`,
 * which the existing server-startup tests deliberately avoid running past its checks). Approval
 * itself is never an HTTP call (it is `ctxd pool approve-key-transfer`, run locally on the
 * source), so it is exercised here as a direct function call against the same database the
 * listener serves from, exactly what the real CLI command does.
 */

const PORT = 18420;
let server: RunningSyncServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function now(): string {
  return new Date().toISOString();
}

function freshDb() {
  return openDatabase(join(mkdtempSync(join(tmpdir(), "ctxd-key-transfer-http-")), "ctxd.db"), { create: true });
}

async function post(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("sealed pool key transfer over the real sync listener (W2)", () => {
  it("returns 404 for both endpoints when sealed_pools.key_transfer is off", async () => {
    const db = freshDb();
    const nodeId = newId();
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'source', 'home', ?)").run(nodeId, now());
    server = await startSyncServer({ db, nodeId, listen: `127.0.0.1:${PORT}`, flags: new Map([["sealed_pools.key_transfer", false]]) });

    const token = newId();
    db.prepare(
      "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at, remote_node_id, remote_public_key) VALUES (?, 'requester', 'https://r.example/sync', 'home', ?, ?, 'node-b', 'pub')",
    ).run(newId(), sha256Hex(token), now());

    const res = await post("/v1/key-transfer/request", token, { poolId: "p1", requesterPrekey: { nodeId: "node-b", publicKey: "x", signature: "y" } });
    expect(res.status).toBe(404);
  });

  it("completes a real request/fetch round trip over HTTP, with approval as a local call on the same database", async () => {
    const sourceDb = freshDb();
    const sourceDbPath = (sourceDb.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get() as { file: string }).file;
    const sourceNodeId = newId();
    sourceDb.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'source', 'home', ?)").run(sourceNodeId, now());
    const poolId = newId();
    sourceDb.prepare("INSERT INTO pools (pool_id, name, storage, created_at) VALUES (?, 'pool-dev', 'sealed', ?)").run(poolId, now());
    const poolKey = Buffer.alloc(32, 9);
    const sourceKeys = new TestKeyProvider();
    sourceKeys.store(poolId, poolKey);

    // The requester's identity, as it would exist on its own machine (a second database); only its
    // public material and signing keypair are needed here to build a real, verifiable request.
    const requesterNodeId = newId();
    const requesterSigning = new FileEventKeyProvider(":memory:").keyPair(requesterNodeId);
    const requesterEnc: EncryptionKeyPair = new FileEncryptionKeyProvider(":memory:").keyPair(requesterNodeId);

    const token = newId();
    sourceDb.prepare(
      "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at, remote_node_id, remote_public_key) VALUES (?, 'requester', 'https://r.example/sync', 'home', ?, ?, ?, ?)",
    ).run(newId(), sha256Hex(token), now(), requesterNodeId, requesterSigning.publicKey.export({ type: "spki", format: "der" }).toString("base64"));

    server = await startSyncServer({ db: sourceDb, nodeId: sourceNodeId, listen: `127.0.0.1:${PORT}`, sealedKeys: sourceKeys, flags: new Map([["sealed_pools.key_transfer", true]]) });

    const requesterPrekey: SignedPrekey = { nodeId: requesterNodeId, ...signEncryptionPrekey(requesterNodeId, requesterEnc, requesterSigning.privateKey) };
    const requestRes = await post("/v1/key-transfer/request", token, { poolId, requesterPrekey });
    expect(requestRes.status).toBe(200);
    const { transferId, sourcePrekey } = (await requestRes.json()) as { transferId: string; sourcePrekey: SignedPrekey };
    expect(sourcePrekey.nodeId).toBe(sourceNodeId);

    // Fetching before approval is refused, over the real HTTP path too.
    const tooEarly = await post("/v1/key-transfer/fetch", token, { transferId });
    expect(tooEarly.status).toBe(400);

    // Approval happens locally on the source, never over HTTP. The listener's own handler
    // generated the source prekey through a file-backed provider keyed by the db's own path, so
    // approving with that same provider instance resolves to the identical in-memory keypair.
    const sourceEnc = new FileEncryptionKeyProvider(sourceDbPath).keyPair(sourceNodeId);
    const approval = approveKeyTransfer(sourceDb, transferId, sourceEnc, poolKey);
    expect(approval.confirmationCode).toMatch(/^\d{6}$/);

    const fetchRes = await post("/v1/key-transfer/fetch", token, { transferId });
    expect(fetchRes.status).toBe(200);
    const { wrappedKey } = (await fetchRes.json()) as { wrappedKey: unknown };
    expect(wrappedKey).toBeTruthy();

    // Replay over HTTP is refused too.
    const replay = await post("/v1/key-transfer/fetch", token, { transferId });
    expect(replay.status).toBe(400);
  });
});
