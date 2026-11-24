import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addPeer, revokePeer } from "../../src/cli/node.js";
import { runInit } from "../../src/cli/init.js";
import { openDatabase } from "../../src/store/db.js";
import type { KeychainOptions } from "../../src/access/keychain.js";
import { migratePeerOutgoingTokens, readPeerOutgoingToken } from "../../src/sync/peer-token.js";

/** Outgoing peer sync tokens live in the keychain; the database keeps only a reference. */

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "peer-token-value-0123456789abcdef-0123456789abcdef-0123456789abcdef-xyz";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctxd-peer-token-")); scratch.push(root);
  const configPath = join(root, "config.toml");
  const dataDir = join(root, "data");
  expect(runInit({ configPath, dataDir, name: "node-a" })).toBe(0);
  const dbPath = join(dataDir, "ctxd.db");
  return { configPath, dbPath, db: openDatabase(dbPath) };
}

/** A fake keychain keyed by service and account, so tests never touch the real one. */
function fakeKeychain(failWrites = false): { opts: KeychainOptions; store: Map<string, string> } {
  const store = new Map<string, string>();
  const exec = (args: readonly string[]): string => {
    const key = `${args[args.indexOf("-s") + 1]}/${args[args.indexOf("-a") + 1]}`;
    if (args[0] === "add-generic-password") {
      if (failWrites) throw new Error("keychain locked");
      store.set(key, args[args.indexOf("-w") + 1] as string);
      return "";
    }
    if (args[0] === "find-generic-password") {
      const value = store.get(key);
      if (value === undefined) throw new Error("not found");
      return `${value}\n`;
    }
    if (args[0] === "delete-generic-password") {
      if (!store.delete(key)) throw new Error("not found");
      return "";
    }
    throw new Error(`unexpected security args: ${args.join(" ")}`);
  };
  return { opts: { exec }, store };
}

function storedToken(db: ReturnType<typeof openDatabase>, name: string): string | null {
  return (db.prepare("SELECT outgoing_token FROM peers WHERE name = ?").get(name) as { outgoing_token: string | null }).outgoing_token;
}

/** Every byte of the database on disk, including the WAL, as a backup or copy would see it. */
function databaseBytes(dbPath: string): string {
  return [dbPath, `${dbPath}-wal`].filter((p) => existsSync(p)).map((p) => readFileSync(p).toString("latin1")).join("");
}

describe("outgoing peer tokens are kept out of the database", () => {
  it("add-peer with --token stores the token in the keychain and only a reference in the row (regression)", () => {
    const f = fixture();
    const keychain = fakeKeychain();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(addPeer(f.db, "node-b", "http://127.0.0.1:9", { role: "home", token: TOKEN, keychain: keychain.opts }, f.configPath)).toBe(0);

    const stored = storedToken(f.db, "node-b");
    expect(stored).toMatch(/^keychain:peer-outgoing\//);
    expect(stored).not.toContain(TOKEN);
    expect([...keychain.store.values()]).toEqual([TOKEN]);
    expect(readPeerOutgoingToken(stored, keychain.opts)).toBe(TOKEN);

    f.db.close();
    expect(databaseBytes(f.dbPath)).not.toContain(TOKEN);
  });

  it("the add-peer update path (token supplied later) also stores only a reference", () => {
    const f = fixture();
    const keychain = fakeKeychain();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(addPeer(f.db, "node-b", "http://127.0.0.1:9", { role: "home", keychain: keychain.opts }, f.configPath)).toBe(0);
    expect(storedToken(f.db, "node-b")).toBeNull();
    expect(addPeer(f.db, "node-b", "http://127.0.0.1:9", { role: "home", token: TOKEN, keychain: keychain.opts }, f.configPath)).toBe(0);

    const stored = storedToken(f.db, "node-b");
    expect(stored).toMatch(/^keychain:/);
    expect(readPeerOutgoingToken(stored, keychain.opts)).toBe(TOKEN);
    f.db.close();
    expect(databaseBytes(f.dbPath)).not.toContain(TOKEN);
  });

  it("revoking a peer deletes its keychain secret and clears the reference", () => {
    const f = fixture();
    const keychain = fakeKeychain();
    vi.spyOn(console, "log").mockImplementation(() => {});
    addPeer(f.db, "node-b", "http://127.0.0.1:9", { role: "home", token: TOKEN, keychain: keychain.opts }, f.configPath);
    expect(revokePeer(f.db, "node-b", keychain.opts)).toBe(0);
    expect(storedToken(f.db, "node-b")).toBeNull();
    expect(keychain.store.size).toBe(0);
  });

  it("a reference whose keychain secret is gone resolves to null, not to the reference itself", () => {
    expect(readPeerOutgoingToken("keychain:peer-outgoing/missing", fakeKeychain().opts)).toBeNull();
    expect(readPeerOutgoingToken(null, fakeKeychain().opts)).toBeNull();
  });
});

describe("migrating raw outgoing tokens stored by earlier versions", () => {
  function insertLegacyPeer(db: ReturnType<typeof openDatabase>, peerId: string, name: string, token: string | null): void {
    db.prepare("INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, outgoing_token, created_at) VALUES (?, ?, 'http://127.0.0.1:9', 'home', 'h', ?, ?)")
      .run(peerId, name, token, new Date().toISOString());
  }

  it("moves each raw token into the keychain, leaves NULL rows alone, and is idempotent", () => {
    const f = fixture();
    const keychain = fakeKeychain();
    insertLegacyPeer(f.db, "peer-1", "node-b", TOKEN);
    insertLegacyPeer(f.db, "peer-2", "node-c", "second-token-value");
    insertLegacyPeer(f.db, "peer-3", "node-d", null);

    expect(migratePeerOutgoingTokens(f.db, keychain.opts)).toEqual({ migrated: 2, failed: [] });
    expect(storedToken(f.db, "node-b")).toBe("keychain:peer-outgoing/peer-1");
    expect(storedToken(f.db, "node-c")).toBe("keychain:peer-outgoing/peer-2");
    expect(storedToken(f.db, "node-d")).toBeNull();
    expect(readPeerOutgoingToken(storedToken(f.db, "node-b"), keychain.opts)).toBe(TOKEN);
    expect(readPeerOutgoingToken(storedToken(f.db, "node-c"), keychain.opts)).toBe("second-token-value");

    expect(migratePeerOutgoingTokens(f.db, keychain.opts)).toEqual({ migrated: 0, failed: [] });
    f.db.close();
    expect(databaseBytes(f.dbPath)).not.toContain(TOKEN);
  });

  it("keeps the raw token (sync still works) and reports the peer when the keychain write fails", () => {
    const f = fixture();
    const keychain = fakeKeychain(true);
    insertLegacyPeer(f.db, "peer-1", "node-b", TOKEN);

    expect(migratePeerOutgoingTokens(f.db, keychain.opts)).toEqual({ migrated: 0, failed: ["node-b"] });
    expect(storedToken(f.db, "node-b")).toBe(TOKEN);
    expect(readPeerOutgoingToken(storedToken(f.db, "node-b"), keychain.opts)).toBe(TOKEN);
  });
});
