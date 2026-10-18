import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { preCompactHandler, sessionEndHandler, stopHandler, postToolUseHandler } from "../../src/hooks/writeMoments.js";
import type { HookContext } from "../../src/cli/hook.js";
import { CLAUDE_CODE_ADAPTER } from "../../src/hooks/adapters.js";

/** Tests for write moments W1 to W4 (PRD-hooks-v5 7.3): the mechanical PreCompact/Stop/SessionEnd/PostToolUse hooks. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-write-moments-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
  clientId: string;
  scopeId: string;
  dataDir: string;
}

function setup(): Fixture {
  const db = freshDb();
  const dataDir = mkdtempSync(join(tmpdir(), "ctxd-write-moments-data-"));
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(scopeId, now());
  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'claude-code', 'anthropic', ?, ?, ?)").run(
    clientId,
    nodeId,
    newId(),
    now(),
  );
  // Access is default deny: a non-human client needs an explicit grant (see read-moments.test.ts).
  db.prepare("INSERT INTO client_grants (client_id, scope_id, level, expires_at, granted_by) VALUES (?, ?, 'write', ?, 'human')").run(
    clientId,
    scopeId,
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  return { db, nodeId, clientId, scopeId, dataDir };
}

function initSession(f: Fixture, sessionRef: string): void {
  f.db
    .prepare("INSERT INTO sessions (session_ref, client_id, scope_id, state, started_at, last_seen_hlc) VALUES (?, ?, ?, 'active', ?, ?)")
    .run(sessionRef, f.clientId, f.scopeId, new Date(Date.now() - 10 * 60_000).toISOString(), `0000000000000-0000-${f.nodeId}`);
}

function baseCtx(f: Fixture, overrides: Partial<HookContext>): HookContext {
  return {
    db: f.db,
    nodeId: f.nodeId,
    clientId: f.clientId,
    clientName: "claude-code",
    adapter: CLAUDE_CODE_ADAPTER,
    event: "stop",
    sessionRef: "claude-code:s1",
    scope: null,
    scopeNotice: null,
    input: {},
    dataDir: f.dataDir,
    config: undefined,
    ...overrides,
  };
}

function initGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "ctxd-write-moments-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial commit", "-q");
  return repo;
}

describe("preCompactHandler (W2)", () => {
  it("writes a checkpoint file and never produces output", async () => {
    const f = setup();
    const repo = initGitRepo();
    const result = await preCompactHandler(baseCtx(f, { event: "pre-compact", input: { cwd: repo } }));
    expect(result).toBeUndefined();

    const checkpointPath = join(f.dataDir, "sessions", "claude-code-s1.checkpoint.json");
    expect(existsSync(checkpointPath)).toBe(true);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as { head: string | null; branch: string | null };
    expect(checkpoint.head).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("stopHandler (W1)", () => {
  it("writes a checkpoint and returns no block when there is no scope", async () => {
    const f = setup();
    const repo = initGitRepo();
    const result = await stopHandler(baseCtx(f, { scope: null, input: { cwd: repo } }));
    expect(result).toBeUndefined();
    expect(existsSync(join(f.dataDir, "sessions", "claude-code-s1.checkpoint.json"))).toBe(true);
  });

  it("blocks once the turns threshold is reached, then the loop guard stops a second block", async () => {
    const f = setup();
    const repo = initGitRepo();
    const ctx = baseCtx(f, {
      scope: "notes",
      config: { nudge: { enabled: true, min_minutes_between: 30, turns_threshold: 1, completion_markers: ["done"] } } as HookContext["config"],
      input: { cwd: repo, last_assistant_message: "still working" },
    });

    const first = await stopHandler(ctx);
    expect(first?.block?.reason).toMatch(/context_handoff/);

    // The client's own "stop hook active" flag simulates the loop guard on the very next call.
    const second = await stopHandler(baseCtx(f, { ...ctx, input: { cwd: repo, stop_hook_active: true } }));
    expect(second).toBeUndefined();
  });

  it("does not block when nudging is disabled", async () => {
    const f = setup();
    const repo = initGitRepo();
    const ctx = baseCtx(f, {
      scope: "notes",
      config: { nudge: { enabled: false, min_minutes_between: 30, turns_threshold: 1, completion_markers: [] } } as HookContext["config"],
      input: { cwd: repo },
    });
    expect(await stopHandler(ctx)).toBeUndefined();
  });
});

describe("sessionEndHandler (W3)", () => {
  it("writes a mechanical journal entry with client, branch, HEAD and changed-file count", () => {
    const f = setup();
    const repo = initGitRepo();
    writeFileSync(join(repo, "untracked.txt"), "x");
    initSession(f, "claude-code:s1");

    const result = sessionEndHandler(baseCtx(f, { event: "session-end", scope: "notes", input: { cwd: repo } }));
    expect(result).toBeUndefined();

    const row = f.db.prepare("SELECT title, body, significance, tags FROM entries WHERE scope_id = ? AND kind = 'journal'").get(f.scopeId) as {
      title: string;
      body: string;
      significance: string;
      tags: string;
    };
    expect(row.title).toBe("Session ended: claude-code");
    expect(row.body).toContain("Client: claude-code");
    expect(row.body).toContain("Changed files: 1");
    expect(row.significance).toBe("routine");
    expect(JSON.parse(row.tags)).toEqual(["auto"]);
  });

  it("does nothing without a bound scope", () => {
    const f = setup();
    expect(sessionEndHandler(baseCtx(f, { event: "session-end", scope: null }))).toBeUndefined();
  });
});

describe("postToolUseHandler (W4)", () => {
  it("ignores a non-Bash tool call", () => {
    const f = setup();
    const result = postToolUseHandler(baseCtx(f, { event: "post-tool-use", scope: "notes", input: { tool_name: "Read", tool_input: { file_path: "x" } } }));
    expect(result).toBeUndefined();
  });

  it("ignores a Bash call that is not a git commit", () => {
    const f = setup();
    const result = postToolUseHandler(
      baseCtx(f, { event: "post-tool-use", scope: "notes", input: { tool_name: "Bash", tool_input: { command: "echo hi" } } }),
    );
    expect(result).toBeUndefined();
  });

  it("journals a successful git commit, linked to its sha, and is idempotent on replay", () => {
    const f = setup();
    const repo = initGitRepo();

    const ctx = baseCtx(f, {
      event: "post-tool-use",
      scope: "notes",
      input: { cwd: repo, tool_name: "Bash", tool_input: { command: "git commit -am 'done'" } },
    });
    expect(postToolUseHandler(ctx)).toBeUndefined();

    const rows = f.db.prepare("SELECT title FROM entries WHERE scope_id = ? AND kind = 'journal'").all(f.scopeId) as { title: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("initial commit");

    const links = f.db.prepare("SELECT target FROM relations WHERE type = 'points_to'").all() as { target: string }[];
    expect(links).toHaveLength(1);
    expect(links[0]!.target).toMatch(/^commit:[0-9a-f]{40}$/);

    // Same HEAD, another PostToolUse call (e.g. a second unrelated git command): no duplicate.
    postToolUseHandler(ctx);
    const after = f.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE scope_id = ? AND kind = 'journal'").get(f.scopeId) as { n: number };
    expect(after.n).toBe(1);
  });
});
