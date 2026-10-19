import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { encodeHlc } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { crashSweep, sweepLeftoverTickets } from "../../src/hooks/crashSweep.js";
import { upsertSession } from "../../src/hooks/sessions.js";
import type { SessionEndTicket } from "../../src/hooks/writeMoments.js";
import "../../src/hooks/handlers.js"; // registers HOOK_HANDLERS["session-start"]
import { dispatchWithDb } from "../../src/cli/hook.js";
import { CLAUDE_CODE_ADAPTER } from "../../src/hooks/adapters.js";

/** Tests for the crash sweep (SPEC v6 section 9.10): orphaned-session finalization at SessionStart. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-crash-sweep-")), "ctxd.db");
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
  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'claude-code', 'anthropic', ?, ?, ?)").run(
    clientId,
    nodeId,
    newId(),
    now(),
  );
  return { db, nodeId, clientId };
}

/** An HLC string timestamped `minutesAgo` minutes before now, for the given node. */
function staleHlc(nodeId: string, minutesAgo: number): string {
  return encodeHlc({ physical: Date.now() - minutesAgo * 60_000, counter: 0, node: nodeId });
}

describe("crashSweep (SPEC v6 section 9.10)", () => {
  it("finalizes a session silent longer than the grace period as ended, recording ended_by: sweep", () => {
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:crashed-1", clientId: f.clientId, scopeId: null, event: "session-start", nodeId: f.nodeId, clearRecovery: true });
    f.db.prepare("UPDATE sessions SET last_seen_hlc = ? WHERE session_ref = ?").run(staleHlc(f.nodeId, 45), "claude-code:crashed-1");

    const swept = crashSweep(f.db, f.nodeId, 30);

    expect(swept).toEqual([{ sessionRef: "claude-code:crashed-1", clientId: f.clientId }]);
    const row = f.db.prepare("SELECT state, ended_by FROM sessions WHERE session_ref = ?").get("claude-code:crashed-1") as { state: string; ended_by: string | null };
    expect(row.state).toBe("ended");
    expect(row.ended_by).toBe("sweep");
  });

  it("keeps recovery intact so the next brief still shows the interrupted-work notice", () => {
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:crashed-2", clientId: f.clientId, scopeId: null, event: "session-start", nodeId: f.nodeId, clearRecovery: true });
    upsertSession(f.db, { sessionRef: "claude-code:crashed-2", clientId: f.clientId, scopeId: null, event: "pre-compact", nodeId: f.nodeId, recovery: { phase: "editing", last_request_summary: "fix the bug" } });
    f.db.prepare("UPDATE sessions SET last_seen_hlc = ? WHERE session_ref = ?").run(staleHlc(f.nodeId, 45), "claude-code:crashed-2");

    crashSweep(f.db, f.nodeId, 30);

    const row = f.db.prepare("SELECT recovery FROM sessions WHERE session_ref = ?").get("claude-code:crashed-2") as { recovery: string };
    expect(JSON.parse(row.recovery)).toEqual({ phase: "editing", last_request_summary: "fix the bug" });
  });

  it("leaves a recently active session alone", () => {
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:fresh-1", clientId: f.clientId, scopeId: null, event: "session-start", nodeId: f.nodeId, clearRecovery: true });

    const swept = crashSweep(f.db, f.nodeId, 30);

    expect(swept).toEqual([]);
    const row = f.db.prepare("SELECT state FROM sessions WHERE session_ref = ?").get("claude-code:fresh-1") as { state: string };
    expect(row.state).toBe("active");
  });

  it("leaves an already-ended session alone", () => {
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:ended-1", clientId: f.clientId, scopeId: null, event: "session-end", nodeId: f.nodeId });
    f.db.prepare("UPDATE sessions SET last_seen_hlc = ? WHERE session_ref = ?").run(staleHlc(f.nodeId, 45), "claude-code:ended-1");

    const swept = crashSweep(f.db, f.nodeId, 30);

    expect(swept).toEqual([]);
  });

  it("is idempotent: sweeping twice only finalizes a crashed session once", () => {
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:crashed-3", clientId: f.clientId, scopeId: null, event: "session-start", nodeId: f.nodeId, clearRecovery: true });
    f.db.prepare("UPDATE sessions SET last_seen_hlc = ? WHERE session_ref = ?").run(staleHlc(f.nodeId, 45), "claude-code:crashed-3");

    const first = crashSweep(f.db, f.nodeId, 30);
    const second = crashSweep(f.db, f.nodeId, 30);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("only sweeps sessions on the given node", () => {
    const f = setup();
    const otherNodeId = newId();
    f.db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'other', 'roaming', ?)").run(otherNodeId, now());
    const otherClientId = newId();
    f.db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'codex', 'openai', ?, ?, ?)").run(otherClientId, otherNodeId, newId(), now());
    upsertSession(f.db, { sessionRef: "codex:other-1", clientId: otherClientId, scopeId: null, event: "session-start", nodeId: otherNodeId, clearRecovery: true });
    f.db.prepare("UPDATE sessions SET last_seen_hlc = ? WHERE session_ref = ?").run(staleHlc(otherNodeId, 45), "codex:other-1");

    const swept = crashSweep(f.db, f.nodeId, 30);

    expect(swept).toEqual([]);
  });
});

describe("the registered session-start handler (via dispatchWithDb)", () => {
  it("runs the crash sweep as a side effect alongside whatever read moments returns", async () => {
    // Read moments (slice 7) registers its own session-start output on top of the crash sweep's
    // side effect; this test only asserts the sweep, not the brief text (see read-moments.test.ts).
    const f = setup();
    upsertSession(f.db, { sessionRef: "claude-code:crashed-4", clientId: f.clientId, scopeId: null, event: "session-start", nodeId: f.nodeId, clearRecovery: true });
    f.db.prepare("UPDATE sessions SET last_seen_hlc = ? WHERE session_ref = ?").run(staleHlc(f.nodeId, 45), "claude-code:crashed-4");

    await dispatchWithDb(
      f.db,
      "session-start",
      CLAUDE_CODE_ADAPTER,
      "claude-code",
      undefined,
      "/tmp",
      { session_id: "new-session", cwd: "/tmp", source: "startup" },
      {},
      "/scratch/ctxd-data",
      undefined,
    );

    const row = f.db.prepare("SELECT state, ended_by FROM sessions WHERE session_ref = ?").get("claude-code:crashed-4") as { state: string; ended_by: string | null };
    expect(row.state).toBe("ended");
    expect(row.ended_by).toBe("sweep");
  });
});

describe("sweepLeftoverTickets (SPEC 9.7): a SessionEnd ticket a crash or reboot left behind", () => {
  function ticketAt(dataDir: string, filename: string, ticket: SessionEndTicket, ageMinutes: number): string {
    const dir = join(dataDir, "sessions");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    writeFileSync(path, JSON.stringify(ticket));
    const past = new Date(Date.now() - ageMinutes * 60_000);
    utimesSync(path, past, past);
    return path;
  }

  function setupWithScope(): Fixture & { scopeId: string } {
    const f = setup();
    const scopeId = newId();
    f.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(scopeId, now());
    f.db.prepare("INSERT INTO client_grants (client_id, scope_id, level, expires_at, granted_by) VALUES (?, ?, 'write', ?, 'human')").run(
      f.clientId,
      scopeId,
      new Date(Date.now() + 86_400_000).toISOString(),
    );
    return { ...f, scopeId };
  }

  it("leaves a fresh ticket alone (its own worker may still be running)", async () => {
    const f = setupWithScope();
    const dataDir = mkdtempSync(join(tmpdir(), "ctxd-crash-sweep-data-"));
    const path = ticketAt(dataDir, "claude-code-s1.123.ticket.json", {
      kind: "session-end",
      sessionRef: "claude-code:s1",
      clientName: "claude-code",
      scope: "notes",
      cwd: "/tmp",
      createdAt: now(),
    }, 1);

    const swept = await sweepLeftoverTickets(f.db, f.nodeId, dataDir, 30);

    expect(swept).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it("processes and removes a ticket older than the grace period, writing the mechanical journal entry", async () => {
    const f = setupWithScope();
    const dataDir = mkdtempSync(join(tmpdir(), "ctxd-crash-sweep-data-"));
    const path = ticketAt(dataDir, "claude-code-s1.123.ticket.json", {
      kind: "session-end",
      sessionRef: "claude-code:s1",
      clientName: "claude-code",
      scope: "notes",
      cwd: "/tmp",
      createdAt: now(),
    }, 45);

    const swept = await sweepLeftoverTickets(f.db, f.nodeId, dataDir, 30);

    expect(swept).toEqual(["claude-code-s1.123.ticket.json"]);
    expect(existsSync(path)).toBe(false);
    const row = f.db.prepare("SELECT title FROM entries WHERE scope_id = ? AND kind = 'journal'").get(f.scopeId) as { title: string } | undefined;
    expect(row?.title).toBe("Session ended: claude-code");
  });

  it("removes a stale ticket for a scope that no longer exists, without throwing", async () => {
    const f = setup(); // no scope created
    const dataDir = mkdtempSync(join(tmpdir(), "ctxd-crash-sweep-data-"));
    const path = ticketAt(dataDir, "claude-code-s1.123.ticket.json", {
      kind: "session-end",
      sessionRef: "claude-code:s1",
      clientName: "claude-code",
      scope: "does-not-exist",
      cwd: "/tmp",
      createdAt: now(),
    }, 45);

    const swept = await sweepLeftoverTickets(f.db, f.nodeId, dataDir, 30);

    expect(swept).toEqual(["claude-code-s1.123.ticket.json"]);
    expect(existsSync(path)).toBe(false);
  });

  it("returns an empty list when there is no sessions directory yet", async () => {
    const f = setup();
    const dataDir = mkdtempSync(join(tmpdir(), "ctxd-crash-sweep-data-"));
    expect(await sweepLeftoverTickets(f.db, f.nodeId, dataDir, 30)).toEqual([]);
  });
});
