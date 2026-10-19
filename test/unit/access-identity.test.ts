import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";
import { newId } from "../../src/core/ids.js";
import { addClient, revokeClient, tagClient } from "../../src/cli/client.js";
import { addScope } from "../../src/cli/scope.js";
import { addMember, createPool, grantPool, removeMember, revokePoolGrant, showPool } from "../../src/cli/pool.js";
import { parseDuration } from "../../src/cli/grant.js";
import { showAccess } from "../../src/cli/access.js";
import { issuePersona, preferPersona, revokePersona, rotatePersona } from "../../src/cli/persona.js";
import { resolveHumanWriteContext } from "../../src/cli/common.js";
import type { KeychainOptions } from "../../src/access/keychain.js";

function freshDb(): { db: Database.Database; configPath: string; nodeId: string } {
  const dir = mkdtempSync(join(tmpdir(), "ctxd-access-"));
  const db = openDatabase(join(dir, "ctxd.db"), { create: true });
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, new Date().toISOString());
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    newId(),
    nodeId,
    newId(),
    new Date().toISOString(),
  );
  db.prepare(
    "INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, '_me', 'me', 'all', 'any', ?)",
  ).run(newId(), new Date().toISOString());
  return { db, configPath: join(dir, "config.toml"), nodeId };
}

/** `WriteContext` for the human client set up by `freshDb`, for `addScope`/`createPool`/`grantPool`/etc. */
function humanCtx(db: Database.Database) {
  return resolveHumanWriteContext(db);
}

/** A fake keychain that records calls instead of touching the real one. */
function fakeKeychain(): { opts: KeychainOptions; store: Map<string, string>; calls: string[][] } {
  const store = new Map<string, string>();
  const calls: string[][] = [];
  const exec = (args: readonly string[]): string => {
    calls.push([...args]);
    const a = args.indexOf("-a"), s = args.indexOf("-s");
    const account = args[a + 1] as string;
    const service = args[s + 1] as string;
    const key = `${service}/${account}`;
    if (args[0] === "add-generic-password") {
      store.set(key, args[args.indexOf("-w") + 1] as string);
      return "";
    }
    if (args[0] === "find-generic-password") {
      const v = store.get(key);
      if (v === undefined) throw new Error("not found");
      return v;
    }
    if (args[0] === "delete-generic-password") {
      if (!store.delete(key)) throw new Error("not found");
      return "";
    }
    throw new Error(`unexpected security args: ${args.join(" ")}`);
  };
  return { opts: { exec }, store, calls };
}

describe("ctxd client (SPEC v6 section 13)", () => {
  it("adds, tags and revokes a client", () => {
    const { db, configPath } = freshDb();
    expect(addClient(db, "codex-laptop", "openai", configPath)).toBe(0);
    const row = db.prepare("SELECT vendor, revoked_at, tags FROM clients WHERE name = 'codex-laptop'").get() as {
      vendor: string;
      revoked_at: string | null;
      tags: string;
    };
    expect(row.vendor).toBe("openai");
    expect(row.revoked_at).toBeNull();
    expect(JSON.parse(row.tags)).toEqual([]);

    expect(tagClient(db, "codex-laptop", "ci")).toBe(0);
    const tagged = db.prepare("SELECT tags FROM clients WHERE name = 'codex-laptop'").get() as { tags: string };
    expect(JSON.parse(tagged.tags)).toEqual(["ci"]);

    expect(revokeClient(db, "codex-laptop")).toBe(0);
    expect(revokeClient(db, "codex-laptop")).toBe(1); // already revoked
    expect(addClient(db, "codex-laptop", "openai", configPath)).toBe(1); // name taken
  });

  it("revokes a client's active persona tokens too, and deletes their keychain secrets (regression)", () => {
    const { db, configPath, nodeId } = freshDb();
    addClient(db, "codex-laptop", "openai", configPath);
    createPool(humanCtx(db), "pool-dev", "");
    const kc = fakeKeychain();
    issuePersona(db, nodeId, "codex-laptop", ["pool-dev"], kc.opts);
    expect(kc.store.size).toBe(1);

    expect(revokeClient(db, "codex-laptop", kc.opts)).toBe(0);
    expect(kc.store.size).toBe(0);
    const token = db.prepare("SELECT revoked_at FROM persona_tokens").get() as { revoked_at: string | null };
    expect(token.revoked_at).not.toBeNull();
  });
});

describe("ctxd scope add", () => {
  it("creates a scope and refuses a duplicate name", () => {
    const { db } = freshDb();
    expect(addScope(humanCtx(db), "notes", "all", "any")).toBe(0);
    expect(addScope(humanCtx(db), "notes", "all", "any")).toBe(1);
    const row = db.prepare("SELECT kind, replication, vendor_policy FROM scopes WHERE name = 'notes'").get();
    expect(row).toEqual({ kind: "project", replication: "all", vendor_policy: "any" });
  });
});

describe("ctxd pool (SPEC v6 section 13)", () => {
  it("creates a pool, grants/revokes scopes, and adds/removes members", () => {
    const { db, configPath } = freshDb();
    addScope(humanCtx(db), "notes", "all", "any");
    addClient(db, "codex-laptop", "openai", configPath);

    expect(createPool(humanCtx(db), "pool-dev", "dev pool")).toBe(0);
    expect(createPool(humanCtx(db), "pool-dev", "")).toBe(1); // duplicate

    expect(grantPool(humanCtx(db), "pool-dev", "notes", "write")).toBe(0);
    expect(addMember(humanCtx(db), "pool-dev", "codex-laptop", false)).toBe(0);
    expect(addMember(humanCtx(db), "pool-dev", "ci", true)).toBe(0);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      showPool(db, "pool-dev");
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).toContain("notes:write");
    expect(logs.join("\n")).toContain("tag:ci");

    expect(revokePoolGrant(humanCtx(db), "pool-dev", "notes")).toBe(0);
    expect(revokePoolGrant(humanCtx(db), "pool-dev", "notes")).toBe(1); // nothing to revoke now
    expect(removeMember(humanCtx(db), "pool-dev", "codex-laptop", false)).toBe(0);
  });

  it("refuses to grant or revoke the reserved _system scope (it holds acl events only)", () => {
    const { db } = freshDb();
    expect(createPool(humanCtx(db), "pool-dev", "dev pool")).toBe(0);
    expect(grantPool(humanCtx(db), "pool-dev", "_system", "write")).toBe(1);
    expect(revokePoolGrant(humanCtx(db), "pool-dev", "_system")).toBe(1);
    expect(db.prepare("SELECT 1 FROM pool_grants").get()).toBeUndefined();
  });
});

describe("ctxd grant: parseDuration", () => {
  it("parses h/d/w ages into milliseconds", () => {
    expect(parseDuration("24h")).toBe(24 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
    expect(parseDuration("2w")).toBe(2 * 7 * 86_400_000);
  });

  it("rejects malformed durations", () => {
    expect(() => parseDuration("tomorrow")).toThrow();
    expect(() => parseDuration("")).toThrow();
  });
});

describe("ctxd access (SPEC v6 section 10.5)", () => {
  it("reports level and reason per scope", () => {
    const { db, configPath } = freshDb();
    addScope(humanCtx(db), "notes", "all", "any");
    addScope(humanCtx(db), "private-a", "all", "any");
    addClient(db, "codex-laptop", "openai", configPath);
    createPool(humanCtx(db), "pool-dev", "");
    grantPool(humanCtx(db), "pool-dev", "notes", "write");
    addMember(humanCtx(db), "pool-dev", "codex-laptop", false);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      expect(showAccess(db, "codex-laptop")).toBe(0);
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    expect(output).toMatch(/notes\s+write\s+pool pool-dev/);
    expect(output).toMatch(/private-a\s+none\s+no grant/);
    expect(output).toMatch(/_me\s+propose\s+global _me/);
  });
});

describe("ctxd persona issue|rotate|revoke|prefer (SPEC v6 section 8.4)", () => {
  it("issues a token, stores the secret, and rejects a duplicate issue", () => {
    const { db, configPath, nodeId } = freshDb();
    addClient(db, "codex-laptop", "openai", configPath);
    createPool(humanCtx(db), "pool-dev", "");
    const kc = fakeKeychain();

    expect(issuePersona(db, nodeId, "codex-laptop", ["pool-dev"], kc.opts)).toBe(0);
    const row = db.prepare("SELECT pools, revoked_at FROM persona_tokens").get() as { pools: string; revoked_at: string | null };
    const poolId = (db.prepare("SELECT pool_id FROM pools WHERE name = 'pool-dev'").get() as { pool_id: string }).pool_id;
    expect(JSON.parse(row.pools)).toEqual([poolId]);
    expect(row.revoked_at).toBeNull();
    expect(kc.store.size).toBe(1);

    expect(issuePersona(db, nodeId, "codex-laptop", ["pool-dev"], kc.opts)).toBe(1); // already active
  });

  it("rotates a token: old one revoked, new one active, keychain updated", () => {
    const { db, configPath, nodeId } = freshDb();
    addClient(db, "codex-laptop", "openai", configPath);
    createPool(humanCtx(db), "pool-dev", "");
    const kc = fakeKeychain();
    issuePersona(db, nodeId, "codex-laptop", ["pool-dev"], kc.opts);
    const before = db.prepare("SELECT token_hash FROM persona_tokens WHERE revoked_at IS NULL").get() as { token_hash: string };

    expect(rotatePersona(db, nodeId, "codex-laptop", ["pool-dev"], kc.opts)).toBe(0);
    const revoked = db.prepare("SELECT revoked_at FROM persona_tokens WHERE token_hash = ?").get(before.token_hash) as {
      revoked_at: string | null;
    };
    expect(revoked.revoked_at).not.toBeNull();
    const active = db.prepare("SELECT token_hash, rotated_from FROM persona_tokens WHERE revoked_at IS NULL").get() as {
      token_hash: string;
      rotated_from: string;
    };
    expect(active.token_hash).not.toBe(before.token_hash);
    expect(active.rotated_from).toBe(before.token_hash);
  });

  it("revokes a token and deletes its keychain secret", () => {
    const { db, configPath, nodeId } = freshDb();
    addClient(db, "codex-laptop", "openai", configPath);
    createPool(humanCtx(db), "pool-dev", "");
    const kc = fakeKeychain();
    issuePersona(db, nodeId, "codex-laptop", ["pool-dev"], kc.opts);
    expect(kc.store.size).toBe(1);

    expect(revokePersona(db, "codex-laptop", ["pool-dev"], kc.opts)).toBe(0);
    expect(kc.store.size).toBe(0);
    expect(revokePersona(db, "codex-laptop", ["pool-dev"], kc.opts)).toBe(1); // nothing active left
  });

  it("sets a persona preference for ambiguous multi-pool scopes", () => {
    const { db, configPath } = freshDb();
    addScope(humanCtx(db), "notes", "all", "any");
    addClient(db, "codex-laptop", "openai", configPath);
    createPool(humanCtx(db), "pool-dev", "");
    expect(preferPersona(db, "codex-laptop", "notes", "pool-dev")).toBe(0);
    const client = db.prepare("SELECT client_id FROM clients WHERE name = 'codex-laptop'").get() as { client_id: string };
    const pref = db.prepare("SELECT pool_id FROM persona_prefs WHERE client_id = ?").get(client.client_id) as { pool_id: string };
    const poolId = (db.prepare("SELECT pool_id FROM pools WHERE name = 'pool-dev'").get() as { pool_id: string }).pool_id;
    expect(pref.pool_id).toBe(poolId);
  });
});
