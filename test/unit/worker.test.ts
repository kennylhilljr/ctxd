import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { processTicketFile, run } from "../../src/cli/worker.js";
import type { SessionEndTicket } from "../../src/hooks/writeMoments.js";

/** `ctxd worker <ticket-path>` (SPEC v8 9.7): the full pipeline from a ticket file on disk to the
 * mechanical SessionEnd work landing in the database, and the ticket being removed. */

interface Fixture {
  dataDir: string;
  db: Database.Database;
  nodeId: string;
  clientId: string;
  scopeId: string;
}

function now(): string {
  return new Date().toISOString();
}

function setup(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxd-worker-"));
  const db = openDatabase(join(dataDir, "ctxd.db"), { create: true });
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'claude-code', 'anthropic', ?, ?, ?)").run(
    clientId,
    nodeId,
    newId(),
    now(),
  );
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(scopeId, now());
  db.prepare("INSERT INTO client_grants (client_id, scope_id, level, expires_at, granted_by) VALUES (?, ?, 'write', ?, 'human')").run(
    clientId,
    scopeId,
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  db.prepare("INSERT INTO sessions (session_ref, client_id, scope_id, state, started_at, last_seen_hlc) VALUES (?, ?, ?, 'active', ?, ?)").run(
    "claude-code:s1",
    clientId,
    scopeId,
    new Date(Date.now() - 5 * 60_000).toISOString(),
    `0000000000000-0000-${nodeId}`,
  );
  db.close();
  return { dataDir, db: openDatabase(join(dataDir, "ctxd.db")), nodeId, clientId, scopeId };
}

function writeTicket(dataDir: string, ticket: SessionEndTicket): string {
  const dir = join(dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude-code-s1.123.ticket.json");
  writeFileSync(path, JSON.stringify(ticket));
  return path;
}

describe("processTicketFile", () => {
  it("performs the session-end work and removes the ticket", async () => {
    const f = setup();
    f.db.close();
    const path = writeTicket(f.dataDir, {
      kind: "session-end",
      sessionRef: "claude-code:s1",
      clientName: "claude-code",
      scope: "notes",
      cwd: "/tmp",
      createdAt: now(),
    });

    await processTicketFile(path, f.dataDir, join(f.dataDir, "does-not-exist.toml"));

    expect(existsSync(path)).toBe(false);
    const db = openDatabase(join(f.dataDir, "ctxd.db"));
    const row = db.prepare("SELECT title, body FROM entries WHERE scope_id = ? AND kind = 'journal'").get(f.scopeId) as { title: string; body: string } | undefined;
    expect(row?.title).toBe("Session ended: claude-code");
    expect(row?.body).toContain("Client: claude-code");
    db.close();
  });

  it("does nothing and leaves no trace when the ticket file does not exist", async () => {
    const f = setup();
    f.db.close();
    await expect(processTicketFile(join(f.dataDir, "sessions", "missing.ticket.json"), f.dataDir, "")).resolves.toBeUndefined();
  });

  it("removes a ticket whose client was revoked, without writing anything", async () => {
    const f = setup();
    f.db.prepare("DELETE FROM clients WHERE client_id = ?").run(f.clientId);
    f.db.close();
    const path = writeTicket(f.dataDir, {
      kind: "session-end",
      sessionRef: "claude-code:s1",
      clientName: "claude-code",
      scope: "notes",
      cwd: "/tmp",
      createdAt: now(),
    });

    await processTicketFile(path, f.dataDir, "");

    expect(existsSync(path)).toBe(false);
    const db = openDatabase(join(f.dataDir, "ctxd.db"));
    const row = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE kind = 'journal'").get() as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });
});

describe("run (CLI entry)", () => {
  it("returns 0 and processes a real ticket end to end", async () => {
    const f = setup();
    f.db.close();
    const path = writeTicket(f.dataDir, {
      kind: "session-end",
      sessionRef: "claude-code:s1",
      clientName: "claude-code",
      scope: "notes",
      cwd: "/tmp",
      createdAt: now(),
    });

    const code = await run([path, "--data-dir", f.dataDir]);

    expect(code).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("returns 0 with no ticket path given (never breaks the caller)", async () => {
    expect(await run([])).toBe(0);
  });

  it("returns 0 even when the data directory does not exist", async () => {
    const scratchHome = mkdtempSync(join(tmpdir(), "ctxd-worker-missing-"));
    expect(await run([join(scratchHome, "nope.ticket.json"), "--data-dir", join(scratchHome, "no-such-data-dir")])).toBe(0);
  });
});
