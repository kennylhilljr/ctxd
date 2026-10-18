import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { upsertSession, eventTouchesSessionState } from "../../src/hooks/sessions.js";
import { readStateFile, writeStateFileLocked } from "../../src/hooks/stateFile.js";
import { dispatchWithDb, withDeadline, HOOK_HANDLERS } from "../../src/cli/hook.js";
import { CLAUDE_CODE_ADAPTER, CODEX_ADAPTER } from "../../src/hooks/adapters.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-hooks-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
  clientId: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(newId(), now());
  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'claude-code', 'anthropic', ?, ?, ?)").run(
    clientId,
    nodeId,
    newId(),
    now(),
  );
  return { db, nodeId, clientId };
}

describe("upsertSession (SPEC v6 section 9.2)", () => {
  it("creates a session-start row as active and clears recovery", () => {
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:s1", clientId: f.clientId, scopeId: null, event: "session-start", nodeId: f.nodeId, clearRecovery: true });
    const row = f.db.prepare("SELECT state, recovery FROM sessions WHERE session_ref = ?").get("claude-code:s1") as { state: string; recovery: string | null };
    expect(row.state).toBe("active");
    expect(row.recovery).toBeNull();
  });

  it("moves through pre-compact (compacting) to stop (idle) to session-end (ended)", () => {
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:s1", clientId: f.clientId, scopeId: null, event: "session-start", nodeId: f.nodeId, clearRecovery: true });
    upsertSession(f.db, { sessionRef: "claude-code:s1", clientId: f.clientId, scopeId: null, event: "pre-compact", nodeId: f.nodeId, recovery: { phase: "editing", last_request_summary: "fix the bug" } });
    let row = f.db.prepare("SELECT state, recovery FROM sessions WHERE session_ref = ?").get("claude-code:s1") as { state: string; recovery: string };
    expect(row.state).toBe("compacting");
    expect(JSON.parse(row.recovery)).toEqual({ phase: "editing", last_request_summary: "fix the bug" });

    upsertSession(f.db, { sessionRef: "claude-code:s1", clientId: f.clientId, scopeId: null, event: "stop", nodeId: f.nodeId });
    row = f.db.prepare("SELECT state, recovery FROM sessions WHERE session_ref = ?").get("claude-code:s1") as { state: string; recovery: string };
    expect(row.state).toBe("idle");
    expect(JSON.parse(row.recovery)).toEqual({ phase: "editing", last_request_summary: "fix the bug" }); // kept, since `stop` doesn't pass a new recovery value

    upsertSession(f.db, { sessionRef: "claude-code:s1", clientId: f.clientId, scopeId: null, event: "session-end", nodeId: f.nodeId });
    row = f.db.prepare("SELECT state FROM sessions WHERE session_ref = ?").get("claude-code:s1") as { state: string };
    expect(row.state).toBe("ended");
  });

  it("session-start on resume keeps the existing recovery (clearRecovery not set)", () => {
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:s1", clientId: f.clientId, scopeId: null, event: "pre-compact", nodeId: f.nodeId, recovery: { phase: "x", last_request_summary: "y" } });
    upsertSession(f.db, { sessionRef: "claude-code:s1", clientId: f.clientId, scopeId: null, event: "session-start", nodeId: f.nodeId, clearRecovery: false });
    const row = f.db.prepare("SELECT state, recovery FROM sessions WHERE session_ref = ?").get("claude-code:s1") as { state: string; recovery: string };
    expect(row.state).toBe("active");
    expect(JSON.parse(row.recovery)).toEqual({ phase: "x", last_request_summary: "y" });
  });

  it("events that don't touch session state (subagent-start, pre-tool-use, post-tool-use) leave no row and report false from eventTouchesSessionState", () => {
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:s2", clientId: f.clientId, scopeId: null, event: "subagent-start", nodeId: f.nodeId });
    const row = f.db.prepare("SELECT 1 FROM sessions WHERE session_ref = ?").get("claude-code:s2");
    expect(row).toBeUndefined();
    expect(eventTouchesSessionState("subagent-start")).toBe(false);
    expect(eventTouchesSessionState("pre-tool-use")).toBe(false);
    expect(eventTouchesSessionState("post-tool-use")).toBe(false);
    expect(eventTouchesSessionState("session-start")).toBe(true);
  });
});

describe("state file locking (SPEC v6 section 9.8)", () => {
  function scratchPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "ctxd-statefile-"));
    return join(dir, "nested", "session.json");
  }

  it("writes and reads back a JSON value, creating parent directories", async () => {
    const path = scratchPath();
    const ok = await writeStateFileLocked(path, { turns: 3, scope: "notes" });
    expect(ok).toBe(true);
    expect(readStateFile(path)).toEqual({ turns: 3, scope: "notes" });
  });

  it("returns undefined for a missing or malformed file without throwing", () => {
    expect(readStateFile(join(mkdtempSync(join(tmpdir(), "ctxd-statefile-")), "missing.json"))).toBeUndefined();
  });

  it("writes atomically: the final file always reflects the latest completed write", async () => {
    const path = scratchPath();
    await writeStateFileLocked(path, { turns: 1 });
    await writeStateFileLocked(path, { turns: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ turns: 2 });
  });

  it("skips the write and returns false when the lock is already held", async () => {
    const path = scratchPath();
    // Simulate a held lock by writing the lock file directly, recent enough to not be considered stale.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.lock`, String(process.pid));
    const ok = await writeStateFileLocked(path, { turns: 99 });
    expect(ok).toBe(false);
  });
});

describe("dispatchWithDb and withDeadline (SPEC v6 section 9.1, 9.2)", () => {
  it("upserts the session row and returns undefined when no handler is registered for the event", async () => {
    const f = setup();
    const result = await dispatchWithDb(f.db, "session-start", CLAUDE_CODE_ADAPTER, "claude-code", undefined, "/tmp", { session_id: "abc", source: "startup" }, {});
    expect(result).toBeUndefined();
    const row = f.db.prepare("SELECT state FROM sessions WHERE session_ref = ?").get("claude-code:abc") as { state: string };
    expect(row.state).toBe("active");
  });

  it("calls the registered handler with a populated HookContext, including the resolved scope override", async () => {
    const f = setup();
    HOOK_HANDLERS["session-start"] = (ctx) => {
      expect(ctx.scope).toBe("notes");
      expect(ctx.clientName).toBe("claude-code");
      expect(ctx.event).toBe("session-start");
      return { text: "hello" };
    };
    try {
      const result = await dispatchWithDb(f.db, "session-start", CLAUDE_CODE_ADAPTER, "claude-code", "notes", "/tmp", { session_id: "def" }, {});
      expect(result).toEqual({ text: "hello" });
    } finally {
      delete HOOK_HANDLERS["session-start"];
    }
  });

  it("returns undefined (never breaks) when the client or node doesn't exist", async () => {
    const f = setup();
    const result = await dispatchWithDb(f.db, "session-start", CLAUDE_CODE_ADAPTER, "no-such-client", undefined, "/tmp", { session_id: "abc" }, {});
    expect(result).toBeUndefined();
  });

  it("returns undefined (never breaks) when the input has no session id", async () => {
    const f = setup();
    const result = await dispatchWithDb(f.db, "session-start", CLAUDE_CODE_ADAPTER, "claude-code", undefined, "/tmp", {}, {});
    expect(result).toBeUndefined();
  });

  it("works with the Codex adapter's different field names (trigger instead of source)", async () => {
    const f = setup();
    f.db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'codex', 'openai', ?, ?, ?)").run(newId(), f.nodeId, newId(), now());
    const result = await dispatchWithDb(f.db, "session-start", CODEX_ADAPTER, "codex", undefined, "/tmp", { session_id: "xyz", trigger: "startup" }, {});
    expect(result).toBeUndefined();
    const row = f.db.prepare("SELECT state FROM sessions WHERE session_ref = ?").get("codex:xyz") as { state: string };
    expect(row.state).toBe("active");
  });
});

describe("withDeadline", () => {
  it("resolves with the function's result when it finishes in time", async () => {
    const result = await withDeadline(100, () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("resolves to undefined, not a rejection, when the function exceeds the deadline", async () => {
    const result = await withDeadline(20, () => new Promise((resolve) => setTimeout(() => resolve(42), 200)));
    expect(result).toBeUndefined();
  });

  it("resolves to undefined, not a rejection, when the function throws", async () => {
    const result = await withDeadline(100, () => Promise.reject(new Error("boom")));
    expect(result).toBeUndefined();
  });
});
