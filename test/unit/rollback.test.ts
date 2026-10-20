import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { CtxdError } from "../../src/core/errors.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { previewRollback, executeRollback } from "../../src/store/rollback.js";

/** `ctxd scope rollback <scope> --to <time>` (SPEC v8 7.6.5). */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-rollback-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Advances `f.time.current` past its current value, but never ahead of real wall-clock time:
 * `executeRollback`/`previewRollback` always use the real `Date.now()` as the window's upper
 * bound (there is no `--until`, by design: rollback means "from `<time>` to now"), so a fixture
 * timestamp placed in the future relative to real time would make the window invalid before the
 * assertion even runs.
 */
function advance(f: Fixture): number {
  f.time.current = Math.max(Date.now(), f.time.current + 1);
  return f.time.current;
}

interface Fixture {
  db: Database.Database;
  clock: HlcClock;
  time: { current: number };
  nodeId: string;
  humanId: string;
  agentId: string;
  scopeName: string;
}

/** A controllable clock (f.time.current), so tests can place events precisely before or after the rollback boundary. */
function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(scopeId, now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    humanId,
    nodeId,
    newId(),
    now(),
  );
  const agentId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-a', 'openai', ?, ?, ?)").run(
    agentId,
    nodeId,
    newId(),
    now(),
  );
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'write')").run(scopeId);

  const time = { current: Date.now() };
  const clock = new HlcClock(nodeId, () => time.current);
  return { db, clock, time, nodeId, humanId, agentId, scopeName: "sample-app" };
}

function ctxFor(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId, assumedPools: ["pool-dev"] };
}

function writeNote(f: Fixture, body: string, update?: { id: string; expectedRev: string }): { id: string; rev: string; ref: string } {
  const result = writeEntry(
    ctxFor(f, f.agentId),
    { scope: f.scopeName, kind: "note", title: "Note", body, request_id: newId(), ...(update ? { id: update.id, expected_rev: update.expectedRev } : {}) } as never,
  );
  if ("held" in result) throw new Error("unexpected hold");
  return result;
}

function entryRow(f: Fixture, entryId: string): { status: string; body: string } {
  return f.db.prepare("SELECT status, body FROM entries WHERE entry_id = ?").get(entryId) as { status: string; body: string };
}

describe("previewRollback", () => {
  it("lists only entries touched at or after the boundary", () => {
    const f = setup();
    const before = writeNote(f, "created before");
    const sinceIso = new Date(advance(f)).toISOString();
    const after = writeNote(f, "created after");

    const preview = previewRollback(f.db, f.scopeName, sinceIso);
    const refs = preview.entries.map((e) => e.ref);
    expect(refs).toContain(after.ref);
    expect(refs).not.toContain(before.ref);
  });

  it("throws NOT_FOUND for an unknown scope", () => {
    const f = setup();
    expect(() => previewRollback(f.db, "no-such-scope", now())).toThrow(CtxdError);
  });
});

describe("executeRollback", () => {
  it("tombstones an entry created entirely after the boundary", () => {
    const f = setup();
    const sinceIso = new Date(advance(f)).toISOString();
    const a = writeNote(f, "created after the boundary");

    const result = executeRollback(ctxFor(f, f.humanId), f.scopeName, sinceIso);
    expect(result.reverted).toBe(1);
    expect(result.conflicted).toBe(0);
    expect(entryRow(f, a.id).status).toBe("deleted");
  });

  it("restores prior content for an entry edited after the boundary, leaving an untouched earlier entry alone", () => {
    const f = setup();
    const a = writeNote(f, "v1");
    const untouched = writeNote(f, "never edited");
    const sinceIso = new Date(advance(f)).toISOString();
    writeNote(f, "v2", { id: a.id, expectedRev: a.rev });

    const result = executeRollback(ctxFor(f, f.humanId), f.scopeName, sinceIso);
    expect(result.reverted).toBe(1);
    expect(entryRow(f, a.id).body).toBe("v1");
    expect(entryRow(f, untouched.id).body).toBe("never edited");
    expect(entryRow(f, untouched.id).status).toBe("active");
  });

  it("throws NOT_FOUND when nothing in the scope matches the window", () => {
    const f = setup();
    writeNote(f, "only before");
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(() => executeRollback(ctxFor(f, f.humanId), f.scopeName, future)).toThrow(CtxdError);
  });

  it("is human only", () => {
    const f = setup();
    const sinceIso = new Date(advance(f)).toISOString();
    writeNote(f, "created after");
    expect(() => executeRollback(ctxFor(f, f.agentId), f.scopeName, sinceIso)).toThrow(/human only/);
  });

  it("throws NOT_FOUND for an unknown scope", () => {
    const f = setup();
    expect(() => executeRollback(ctxFor(f, f.humanId), "no-such-scope", now())).toThrow(CtxdError);
  });
});
