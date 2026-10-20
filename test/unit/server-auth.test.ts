import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";
import { newId } from "../../src/core/ids.js";
import { sha256Hex } from "../../src/core/hash.js";
import { resolveBearerAuth, resolvePeerAuth } from "../../src/server/auth.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-auth-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

describe("resolveBearerAuth (SPEC v6 sections 8.4, 10.5)", () => {
  it("rejects an unknown token", () => {
    const db = freshDb();
    expect(resolveBearerAuth(db, "not-a-real-token")).toBeNull();
  });

  it("resolves a client's plain base token to _me-only (no assumed pools)", () => {
    const db = freshDb();
    const nodeId = newId();
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
    const token = "plain-token-raw";
    db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'codex', 'openai', ?, ?, ?)").run(
      newId(),
      nodeId,
      sha256Hex(token),
      now(),
    );

    const auth = resolveBearerAuth(db, token);
    expect(auth?.clientName).toBe("codex");
    expect(auth?.vendor).toBe("openai");
    expect(auth?.assumedPools).toEqual([]);
  });

  it("rejects the plain token of a revoked client", () => {
    const db = freshDb();
    const nodeId = newId();
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
    const token = "revoked-token";
    db.prepare(
      "INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at, revoked_at) VALUES (?, 'codex', 'openai', ?, ?, ?, ?)",
    ).run(newId(), nodeId, sha256Hex(token), now(), now());

    expect(resolveBearerAuth(db, token)).toBeNull();
  });

  it("resolves a persona token to its client and sorted pool ids", () => {
    const db = freshDb();
    const nodeId = newId();
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
    const clientId = newId();
    db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'codex', 'openai', ?, ?, ?)").run(
      clientId,
      nodeId,
      sha256Hex("unused-base-token"),
      now(),
    );
    const token = "persona-token-raw";
    db.prepare("INSERT INTO persona_tokens (token_hash, client_id, pools, node_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
      sha256Hex(token),
      clientId,
      JSON.stringify(["pool-b", "pool-a"].sort()),
      nodeId,
      now(),
    );

    const auth = resolveBearerAuth(db, token);
    expect(auth?.clientId).toBe(clientId);
    expect(auth?.assumedPools).toEqual(["pool-a", "pool-b"]);
  });

  it("rejects a revoked persona token even though the client is still active", () => {
    const db = freshDb();
    const nodeId = newId();
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
    const clientId = newId();
    db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'codex', 'openai', ?, ?, ?)").run(
      clientId,
      nodeId,
      sha256Hex("unused"),
      now(),
    );
    const token = "revoked-persona";
    db.prepare(
      "INSERT INTO persona_tokens (token_hash, client_id, pools, node_id, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sha256Hex(token), clientId, JSON.stringify(["pool-a"]), nodeId, now(), now());

    expect(resolveBearerAuth(db, token)).toBeNull();
  });

  it("rejects a persona token whose underlying client was later revoked (regression: client.ts's cascade depends on this)", () => {
    const db = freshDb();
    const nodeId = newId();
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
    const clientId = newId();
    db.prepare(
      "INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at, revoked_at) VALUES (?, 'codex', 'openai', ?, ?, ?, ?)",
    ).run(clientId, nodeId, sha256Hex("unused"), now(), now());
    const token = "orphaned-persona";
    db.prepare("INSERT INTO persona_tokens (token_hash, client_id, pools, node_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
      sha256Hex(token),
      clientId,
      JSON.stringify(["pool-a"]),
      nodeId,
      now(),
    );

    expect(resolveBearerAuth(db, token)).toBeNull();
  });
});

describe("resolvePeerAuth", () => {
  it("returns the durable remote node identity and key bound to the token", () => {
    const db = freshDb();
    const token = "peer-token";
    db.prepare("INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at, remote_node_id, remote_public_key) VALUES (?, 'node-b', 'http://127.0.0.1:7412', 'home', ?, ?, ?, ?)")
      .run(newId(), sha256Hex(token), now(), "remote-node-id", "remote-public-key");
    expect(resolvePeerAuth(db, token)).toMatchObject({ remoteNodeId: "remote-node-id", remotePublicKey: "remote-public-key" });
  });
});
