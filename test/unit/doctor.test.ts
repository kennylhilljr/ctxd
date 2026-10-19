import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";
import { configSchema } from "../../src/config/config.js";
import { installClaudeCodeHooks, installCodexHooks } from "../../src/cli/install-hooks.js";
import {
  checkBindAddresses,
  checkDatabaseHealth,
  checkFileVault,
  checkHookInstallation,
  checkPeers,
  checkReviewRuleNarrowness,
  checkTokenFilePermissions,
} from "../../src/cli/doctor.js";

/** `ctxd doctor` (SPEC v8 section 12, M4 slice 4): one test per check, each using a scratch
 * database or scratch home directory, never real config or real tokens. */

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "ctxd-doctor-"));
}

function freshDb(dataDir: string) {
  return openDatabase(join(dataDir, "ctxd.db"), { create: true });
}

describe("checkBindAddresses", () => {
  it("passes when both listeners are loopback", () => {
    const config = configSchema.parse({ node: { name: "n", role: "home" }, mcp: { listen: "127.0.0.1:7411" }, sync: { listen: "[::1]:7412" } });
    expect(checkBindAddresses(config).ok).toBe(true);
  });

  it("fails when a listener binds to a non-loopback address", () => {
    const config = configSchema.parse({ node: { name: "n", role: "home" }, mcp: { listen: "0.0.0.0:7411" } });
    const result = checkBindAddresses(config);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("0.0.0.0:7411");
  });
});

describe("checkTokenFilePermissions", () => {
  it("passes when every token file is 0600", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ctxd-doctor-cfg-"));
    const tokensDir = join(configDir, "tokens");
    mkdirSync(tokensDir, { recursive: true });
    const tokenPath = join(tokensDir, "human.token");
    writeFileSync(tokenPath, "secret");
    chmodSync(tokenPath, 0o600);
    expect(checkTokenFilePermissions(join(configDir, "config.toml")).ok).toBe(true);
  });

  it("fails when a token file is readable by group or other", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ctxd-doctor-cfg-"));
    const tokensDir = join(configDir, "tokens");
    mkdirSync(tokensDir, { recursive: true });
    const tokenPath = join(tokensDir, "human.token");
    writeFileSync(tokenPath, "secret");
    chmodSync(tokenPath, 0o644);
    const result = checkTokenFilePermissions(join(configDir, "config.toml"));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("human.token");
  });

  it("passes with no tokens directory yet", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ctxd-doctor-cfg-"));
    expect(checkTokenFilePermissions(join(configDir, "config.toml")).ok).toBe(true);
  });
});

describe("checkDatabaseHealth", () => {
  it("passes for a freshly initialized database", () => {
    const db = freshDb(tmpDataDir());
    expect(checkDatabaseHealth(db).ok).toBe(true);
    db.close();
  });
});

describe("checkReviewRuleNarrowness", () => {
  it("passes when scopes have no rules, or only narrow ones", () => {
    const db = freshDb(tmpDataDir());
    db.prepare(
      "INSERT INTO scopes (scope_id, name, review_policy, created_at) VALUES (?, 'narrow', ?, datetime('now'))",
    ).run(randomUUID(), JSON.stringify([{ kind: "convention", client: "claude-code", action: "auto-accept" }]));
    expect(checkReviewRuleNarrowness(db).ok).toBe(true);
    db.close();
  });

  it("fails on a rule with no client and no confirmed_by_user", () => {
    const db = freshDb(tmpDataDir());
    db.prepare(
      "INSERT INTO scopes (scope_id, name, review_policy, created_at) VALUES (?, 'broad', ?, datetime('now'))",
    ).run(randomUUID(), JSON.stringify([{ kind: "convention", action: "auto-accept" }]));
    const result = checkReviewRuleNarrowness(db);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("broad[0]");
    db.close();
  });

  it("fails on a rule targeting kind skill or preference", () => {
    const db = freshDb(tmpDataDir());
    db.prepare(
      "INSERT INTO scopes (scope_id, name, review_policy, created_at) VALUES (?, 'skillrule', ?, datetime('now'))",
    ).run(randomUUID(), JSON.stringify([{ kind: "skill", client: "claude-code", action: "auto-accept" }]));
    expect(checkReviewRuleNarrowness(db).ok).toBe(false);
    db.close();
  });
});

describe("checkPeers", () => {
  it("passes with no peers configured", async () => {
    const db = freshDb(tmpDataDir());
    const result = await checkPeers(db);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("no peers configured");
    db.close();
  });

  it("reports a reachable and an unreachable peer, using an injected fetch", async () => {
    const db = freshDb(tmpDataDir());
    db.prepare(
      "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at) VALUES (?, 'up', 'https://up.example/sync', 'home', 'h', datetime('now'))",
    ).run(randomUUID());
    db.prepare(
      "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at) VALUES (?, 'down', 'https://down.example/sync', 'home', 'h', datetime('now'))",
    ).run(randomUUID());

    const fakeFetch = (async (url: string | URL) => {
      if (url.toString().includes("down.example")) throw new Error("connection refused");
      return new Response("ok");
    }) as typeof fetch;

    const result = await checkPeers(db, fakeFetch);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("up: reachable");
    expect(result.detail).toContain("down: unreachable");
    db.close();
  });
});

describe("checkFileVault", () => {
  it("reports on, parsing a real fdesetup-shaped output", () => {
    const fakeExecFile = (() => "FileVault is On.\n") as unknown as typeof import("node:child_process").execFileSync;
    expect(checkFileVault(fakeExecFile).ok).toBe(true);
  });

  it("reports off", () => {
    const fakeExecFile = (() => "FileVault is Off.\n") as unknown as typeof import("node:child_process").execFileSync;
    expect(checkFileVault(fakeExecFile).ok).toBe(false);
  });

  it("fails without crashing when fdesetup itself errors", () => {
    const fakeExecFile = (() => {
      throw new Error("fdesetup: command not found");
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = checkFileVault(fakeExecFile);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not check");
  });
});

describe("checkHookInstallation", () => {
  it("fails for a fresh home with neither client installed", () => {
    const home = mkdtempSync(join(tmpdir(), "ctxd-doctor-home-"));
    const result = checkHookInstallation(home);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("claude-code");
    expect(result.detail).toContain("codex");
  });

  it("passes once both clients have ctxd's hooks installed", () => {
    const home = mkdtempSync(join(tmpdir(), "ctxd-doctor-home-"));
    installClaudeCodeHooks(join(home, ".claude", "settings.json"));
    installCodexHooks(join(home, ".codex", "config.toml"));
    expect(checkHookInstallation(home).ok).toBe(true);
  });
});
