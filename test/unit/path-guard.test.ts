import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { checkPathGuard } from "../../src/hooks/pathGuard.js";
import "../../src/hooks/handlers.js"; // registers HOOK_HANDLERS["pre-tool-use"]
import { dispatchWithDb } from "../../src/cli/hook.js";
import { CLAUDE_CODE_ADAPTER } from "../../src/hooks/adapters.js";

describe("checkPathGuard (SPEC v6 section 9.9)", () => {
  const guarded = ["/Users/example/Library/Application Support/ctxd"];

  it("denies a Read/Edit/Write whose file_path is under the guarded directory", () => {
    const result = checkPathGuard("Read", { file_path: "/Users/example/Library/Application Support/ctxd/ctxd.db" }, guarded);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/ctxd data is managed by the ctxd server/);
  });

  it("denies a Glob/Grep whose path is exactly the guarded directory", () => {
    const result = checkPathGuard("Glob", { path: "/Users/example/Library/Application Support/ctxd" }, guarded);
    expect(result.blocked).toBe(true);
  });

  it("allows a file outside the guarded directory", () => {
    const result = checkPathGuard("Read", { file_path: "/Users/example/code/sample-app/README.md" }, guarded);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("allows a path that merely shares a string prefix without being a real subdirectory (e.g. a sibling named ctxd-notes)", () => {
    const result = checkPathGuard("Read", { file_path: "/Users/example/Library/Application Support/ctxd-notes/file.md" }, guarded);
    expect(result.blocked).toBe(false);
  });

  it("denies a Bash command whose text mentions the guarded path literally", () => {
    const result = checkPathGuard("Bash", { command: "cat '/Users/example/Library/Application Support/ctxd/ctxd.db'" }, guarded);
    expect(result.blocked).toBe(true);
  });

  it("denies a Bash command using the ~-shorthand for a guarded path under the home directory", () => {
    const home = homedir();
    const result = checkPathGuard("Bash", { command: "rm -rf ~/.config/ctxd" }, [`${home}/.config/ctxd`]);
    expect(result.blocked).toBe(true);
  });

  it("allows an unrelated Bash command", () => {
    const result = checkPathGuard("Bash", { command: "npm test" }, guarded);
    expect(result.blocked).toBe(false);
  });

  it("is a no-op for a tool with no recognized path-bearing field", () => {
    const result = checkPathGuard("WebFetch", { url: "https://example.com" }, guarded);
    expect(result.blocked).toBe(false);
  });
});

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-pathguard-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

describe("the registered pre-tool-use handler (via dispatchWithDb)", () => {
  function setup(): { db: Database.Database; nodeId: string } {
    const db = freshDb();
    const nodeId = newId();
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
    db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'claude-code', 'anthropic', ?, ?, ?)").run(
      newId(),
      nodeId,
      newId(),
      now(),
    );
    return { db, nodeId };
  }

  it("blocks a PreToolUse call targeting the resolved data directory", async () => {
    const { db } = setup();
    const result = await dispatchWithDb(
      db,
      "pre-tool-use",
      CLAUDE_CODE_ADAPTER,
      "claude-code",
      undefined,
      "/tmp",
      { session_id: "s1", tool_name: "Read", tool_input: { file_path: "/scratch/ctxd-data/ctxd.db" } },
      {},
      "/scratch/ctxd-data",
      undefined,
    );
    expect(result?.block?.reason).toMatch(/ctxd data is managed by the ctxd server/);
  });

  it("allows a PreToolUse call targeting an unrelated file", async () => {
    const { db } = setup();
    const result = await dispatchWithDb(
      db,
      "pre-tool-use",
      CLAUDE_CODE_ADAPTER,
      "claude-code",
      undefined,
      "/tmp",
      { session_id: "s2", tool_name: "Read", tool_input: { file_path: "/scratch/sample-app/README.md" } },
      {},
      "/scratch/ctxd-data",
      undefined,
    );
    expect(result).toBeUndefined();
  });
});
