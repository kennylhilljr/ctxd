import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptNode } from "../../src/cli/node.js";
import { runInit } from "../../src/cli/init.js";
import { loadConfig } from "../../src/config/config.js";
import { openDatabase } from "../../src/store/db.js";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctxd-adopt-")); scratch.push(root);
  const configPath = join(root, "config.toml");
  const dataDir = join(root, "data");
  expect(runInit({ configPath, dataDir, name: "node-a" })).toBe(0);
  const db = openDatabase(join(dataDir, "ctxd.db"));
  return { configPath, db };
}

describe("ctxd node adopt", () => {
  it("renames the copied node while preserving its identity", async () => {
    const f = fixture();
    const before = f.db.prepare("SELECT node_id FROM nodes").get() as { node_id: string };
    expect(await adoptNode(f.db, f.configPath, "node-b", async () => false)).toBe(0);
    expect(f.db.prepare("SELECT node_id, name FROM nodes").get()).toEqual({ node_id: before.node_id, name: "node-b" });
    expect(loadConfig(f.configPath).node.name).toBe("node-b");
  });

  it("refuses adoption while the server answers health checks", async () => {
    const f = fixture();
    const probe = vi.fn(async () => true);
    expect(await adoptNode(f.db, f.configPath, "node-b", probe)).toBe(1);
    expect(f.db.prepare("SELECT name FROM nodes").get()).toEqual({ name: "node-a" });
    expect(loadConfig(f.configPath).node.name).toBe("node-a");
  });

  it("refuses a name collision with an active peer", async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at) VALUES ('peer-a', 'node-b', 'http://127.0.0.1:9', 'home', 'hash', ?)").run(new Date().toISOString());
    expect(await adoptNode(f.db, f.configPath, "node-b", async () => false)).toBe(1);
    expect(f.db.prepare("SELECT name FROM nodes").get()).toEqual({ name: "node-a" });
  });
});
