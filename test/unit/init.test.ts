import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";

function sandbox(): { configPath: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ctxd-init-"));
  return { configPath: join(root, "config.toml"), dataDir: join(root, "data") };
}

describe("ctxd init (SPEC v6 13, 1515)", () => {
  it("creates config, data dir, node identity, the human client and _me", () => {
    const { configPath, dataDir } = sandbox();
    const code = runInit({ configPath, dataDir, name: "air", role: "home" });
    expect(code).toBe(0);

    expect(existsSync(configPath)).toBe(true);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, "utf8")).toContain('name = "air"');

    const dbPath = join(dataDir, "ctxd.db");
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);
    const node = db.prepare("SELECT name, role FROM nodes").get() as { name: string; role: string };
    expect(node).toEqual({ name: "air", role: "home" });

    const human = db.prepare("SELECT name, vendor FROM clients").get() as { name: string; vendor: string };
    expect(human).toEqual({ name: "human", vendor: "human" });

    const me = db.prepare("SELECT name, kind, replication, vendor_policy FROM scopes WHERE name = '_me'").get();
    expect(me).toEqual({ name: "_me", kind: "me", replication: "all", vendor_policy: "any" });
    db.close();

    const tokenPath = join(join(configPath, "..", "tokens"), "human.token");
    expect(existsSync(tokenPath)).toBe(true);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenPath, "utf8")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to run twice (config already exists)", () => {
    const { configPath, dataDir } = sandbox();
    expect(runInit({ configPath, dataDir })).toBe(0);
    expect(runInit({ configPath, dataDir })).toBe(1);
  });

  it("refuses to create a database over an existing path even without a config file", () => {
    const { configPath, dataDir } = sandbox();
    runInit({ configPath, dataDir });
    const otherConfig = join(dataDir, "..", "config2.toml");
    expect(runInit({ configPath: otherConfig, dataDir })).toBe(1);
  });

  it("expands ~ in --config to the home directory (regression: was passed through unexpanded)", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ctxd-init-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const dataDir = join(fakeHome, "data");
      expect(runInit({ configPath: "~/config.toml", dataDir })).toBe(0);
      expect(existsSync(join(fakeHome, "config.toml"))).toBe(true);
      expect(existsSync(join(fakeHome, "~"))).toBe(false);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("reports a clean error instead of throwing on invalid input (regression: uncaught ZodError)", () => {
    const { configPath, dataDir } = sandbox();
    expect(runInit({ configPath, dataDir, name: "" })).toBe(1);
    expect(existsSync(configPath)).toBe(false);
  });
});
