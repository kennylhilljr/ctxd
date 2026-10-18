import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { flagEntry } from "../../src/store/flag.js";
import { CtxdError } from "../../src/core/errors.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-flag-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  clock: HlcClock;
  nodeId: string;
  humanId: string;
  agentId: string;
  notesScopeId: string;
  privateAScopeId: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const notesScopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(notesScopeId, now());
  const privateAScopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'private-a', ?)").run(privateAScopeId, now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    humanId,
    nodeId,
    newId(),
    now(),
  );
  const agentId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'codex@laptop', 'openai', ?, ?, ?)").run(
    agentId,
    nodeId,
    newId(),
    now(),
  );
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'read')").run(notesScopeId);
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, agentId, notesScopeId, privateAScopeId };
}

function writeCtx(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId };
}

describe("flagEntry (SPEC v6 section 7.6.1)", () => {
  it("flags an entry and sets status to flagged, recording status_before", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "Body.", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const result = flagEntry(writeCtx(f, f.humanId), { ref: created.ref, problem: "stale", reason: "No longer true.", request_id: newId() });
    expect(result).toEqual({ ref: created.ref, status: "flagged", flags: 1 });
    const row = f.db.prepare("SELECT status, status_before FROM entries WHERE entry_id = ?").get(created.id) as {
      status: string;
      status_before: string;
    };
    expect(row.status).toBe("flagged");
    expect(row.status_before).toBe("active");
  });

  it("a read-only agent client (with only read access) can still flag", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "Body.", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const result = flagEntry({ ...writeCtx(f, f.agentId), assumedPools: ["pool-dev"] }, {
      ref: created.ref,
      problem: "wrong",
      reason: "Incorrect.",
      request_id: newId(),
    });
    expect(result.status).toBe("flagged");
  });

  it("rejects flagging an entry in a scope with no access at all", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "private-a", kind: "note", title: "N", body: "Body.", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");

    expect(() =>
      flagEntry({ ...writeCtx(f, f.agentId), assumedPools: ["pool-dev"] }, { ref: created.ref, problem: "wrong", reason: "x", request_id: newId() }),
    ).toThrow(CtxdError);
  });

  it("additional flags on an already-flagged entry leave status and status_before unchanged (regression: SPEC 7.6.1)", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "Body.", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");

    flagEntry(writeCtx(f, f.humanId), { ref: created.ref, problem: "stale", reason: "First.", request_id: newId() });
    const second = flagEntry(writeCtx(f, f.humanId), { ref: created.ref, problem: "wrong", reason: "Second.", request_id: newId() });
    expect(second.flags).toBe(2);
    const row = f.db.prepare("SELECT status, status_before FROM entries WHERE entry_id = ?").get(created.id) as {
      status: string;
      status_before: string;
    };
    expect(row.status).toBe("flagged");
    expect(row.status_before).toBe("active");
  });

  it("is idempotent on a retried request_id and does not add a second flag row", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "Body.", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    const reqId = newId();

    const first = flagEntry(writeCtx(f, f.humanId), { ref: created.ref, problem: "stale", reason: "x", request_id: reqId });
    const second = flagEntry(writeCtx(f, f.humanId), { ref: created.ref, problem: "stale", reason: "x", request_id: reqId });
    expect(first).toEqual(second);
    const count = (f.db.prepare("SELECT COUNT(*) AS n FROM flags WHERE entry_id = ?").get(created.id) as { n: number }).n;
    expect(count).toBe(1);
  });

  it("records an open unsafe flag (regression: search/fts.ts excludes these until resolved)", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Secret leak", body: "Body.", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    flagEntry(writeCtx(f, f.humanId), { ref: created.ref, problem: "unsafe", reason: "Leaked a token.", request_id: newId() });

    const row = f.db.prepare("SELECT problem, resolved FROM flags WHERE entry_id = ?").get(created.id) as {
      problem: string;
      resolved: string | null;
    };
    expect(row.problem).toBe("unsafe");
    expect(row.resolved).toBeNull();
  });
});
