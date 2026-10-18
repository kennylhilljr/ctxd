import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { CtxdError } from "../../src/core/errors.js";
import { openDatabase } from "../../src/store/db.js";
import { handleClaim, type ClaimInput } from "../../src/store/claim.js";
import { openQuarantine, releaseBatch, revertBatch, showBatch } from "../../src/store/hygiene.js";
import { rebuild } from "../../src/store/rebuild.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-hygiene-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  clock: HlcClock;
  time: { current: number };
  nodeId: string;
  humanId: string;
  agentAId: string;
  agentBId: string;
  scopeName: string;
}

/** Scope "sample-app", writable by agent-a and agent-b through pool-dev; a controllable clock so tests can place events precisely inside or outside a quarantine window. */
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
  const agentAId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-a', 'openai', ?, ?, ?)").run(
    agentAId,
    nodeId,
    newId(),
    now(),
  );
  const agentBId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-b', 'openai', ?, ?, ?)").run(
    agentBId,
    nodeId,
    newId(),
    now(),
  );

  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentAId}`);
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentBId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'write')").run(scopeId);

  const time = { current: Date.now() };
  const clock = new HlcClock(nodeId, () => time.current);
  return { db, clock, time, nodeId, humanId, agentAId, agentBId, scopeName: "sample-app" };
}

/** One shared clock for the whole fixture (a real node has exactly one), driven by `f.time.current` so tests can advance it explicitly. */
function ctxFor(f: Fixture, clientId: string, assumedPools: string[] = ["pool-dev"]): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId, assumedPools };
}

function claim(input: Partial<ClaimInput> & { scope: string; action: ClaimInput["action"] }): ClaimInput {
  return { ttl_minutes: 120, ...input };
}

function writeNote(f: Fixture, clientId: string, body: string, update?: { id: string; expectedRev: string }): { id: string; rev: string } {
  const result = writeEntry(
    ctxFor(f, clientId),
    {
      scope: f.scopeName,
      kind: "note",
      title: "Note",
      body,
      request_id: newId(),
      ...(update ? { id: update.id, expected_rev: update.expectedRev } : {}),
    } as never,
  );
  if ("held" in result) throw new Error("unexpected hold");
  return { id: result.id, rev: result.rev };
}

function entryRow(f: Fixture, entryId: string): { status: string; status_before: string | null; body: string } {
  return f.db.prepare("SELECT status, status_before, body FROM entries WHERE entry_id = ?").get(entryId) as {
    status: string;
    status_before: string | null;
    body: string;
  };
}

describe("openQuarantine (SPEC v6 section 7.6.2)", () => {
  it("hides only the selected client's entries, recording status_before", () => {
    const f = setup();
    const a = writeNote(f, f.agentAId, "from agent-a");
    const b = writeNote(f, f.agentBId, "from agent-b");

    const result = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a" });
    expect(result.entries).toBe(1);

    const rowA = entryRow(f, a.id);
    expect(rowA.status).toBe("quarantined");
    expect(rowA.status_before).toBe("active");
    const rowB = entryRow(f, b.id);
    expect(rowB.status).toBe("active");

    const shown = showBatch(f.db, result.batch_id);
    expect(shown.members).toHaveLength(1);
    expect(shown.members[0]!.entry_id).toBe(a.id);
    expect(shown.state).toBe("open");
  });

  it("is human only", () => {
    const f = setup();
    writeNote(f, f.agentAId, "x");
    expect(() => openQuarantine(ctxFor(f, f.agentAId), { client: "agent-a" })).toThrow(CtxdError);
  });

  it("rejects a selector with neither client nor session", () => {
    const f = setup();
    expect(() => openQuarantine(ctxFor(f, f.humanId), {})).toThrow(/at least one of/i);
  });
});

describe("releaseBatch (SPEC v6 section 7.6.4)", () => {
  it("restores status_before and moves the batch to released", () => {
    const f = setup();
    const a = writeNote(f, f.agentAId, "from agent-a");
    const q = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a" });
    expect(entryRow(f, a.id).status).toBe("quarantined");

    const released = releaseBatch(ctxFor(f, f.humanId), q.batch_id);
    expect(released.state).toBe("released");
    expect(released.members).toEqual([{ entry_id: a.id, outcome: "released" }]);

    const row = entryRow(f, a.id);
    expect(row.status).toBe("active");
    expect(row.status_before).toBeNull();
  });
});

describe("revertBatch (SPEC v6 section 7.6.3)", () => {
  it("tombstones an entry created inside the window", () => {
    const f = setup();
    f.time.current += 1000;
    const sinceIso = new Date(f.time.current).toISOString();
    const a = writeNote(f, f.agentAId, "created inside the window");
    f.time.current += 1000;
    const untilIso = new Date(f.time.current).toISOString();

    const q = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a", since: sinceIso, until: untilIso });
    const shown = showBatch(f.db, q.batch_id);
    expect(shown.members[0]!.created_in_batch).toBe(true);

    const reverted = revertBatch(ctxFor(f, f.humanId), q.batch_id);
    expect(reverted.state).toBe("reverted");
    expect(reverted.members).toEqual([{ entry_id: a.id, outcome: "reverted" }]);
    expect(entryRow(f, a.id).status).toBe("deleted");
  });

  it("restores prior content for an entry edited inside the window, leaving an entry created before the window untouched", () => {
    const f = setup();
    const a = writeNote(f, f.agentAId, "v1");
    f.time.current += 1000;
    const sinceIso = new Date(f.time.current).toISOString();
    const updated = writeNote(f, f.agentAId, "v2", { id: a.id, expectedRev: a.rev });
    f.time.current += 1000;
    const untilIso = new Date(f.time.current).toISOString();

    const q = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a", since: sinceIso, until: untilIso });
    const shown = showBatch(f.db, q.batch_id);
    expect(shown.members[0]!.created_in_batch).toBe(false);
    expect(entryRow(f, a.id).status).toBe("quarantined");
    expect(entryRow(f, a.id).body).toBe("v2");

    const reverted = revertBatch(ctxFor(f, f.humanId), q.batch_id);
    expect(reverted.state).toBe("reverted");
    expect(reverted.members).toEqual([{ entry_id: a.id, outcome: "reverted" }]);
    const row = entryRow(f, a.id);
    expect(row.body).toBe("v1");
    expect(row.status).toBe("active");
    void updated;
  });

  it("marks a member conflicted, keeping it untouched, when another client edits the same part after the window", () => {
    const f = setup();
    const a = writeNote(f, f.agentAId, "v1");
    f.time.current += 1000;
    const sinceIso = new Date(f.time.current).toISOString();
    const inWindow = writeNote(f, f.agentAId, "v2", { id: a.id, expectedRev: a.rev });
    f.time.current += 1000;
    const untilIso = new Date(f.time.current).toISOString();

    const q = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a", since: sinceIso, until: untilIso });

    f.time.current += 1000;
    writeNote(f, f.agentBId, "v3 from agent-b", { id: a.id, expectedRev: inWindow.rev });

    const reverted = revertBatch(ctxFor(f, f.humanId), q.batch_id);
    expect(reverted.state).toBe("partial"); // the batch's only member conflicted rather than reverting cleanly
    expect(reverted.members).toEqual([{ entry_id: a.id, outcome: "conflict" }]);

    const row = entryRow(f, a.id);
    expect(row.status).toBe("conflicted");
    expect(row.body).toBe("v3 from agent-b"); // the later, non-reverted edit from another client is untouched

    const sibling = f.db.prepare("SELECT entry_id, part, reason FROM entry_siblings WHERE entry_id = ?").get(a.id) as
      | { entry_id: string; part: string; reason: string }
      | undefined;
    expect(sibling).toBeDefined();
    expect(sibling!.part).toBe("content");
    expect(sibling!.reason).toBe("revert-conflict");
  });

  it("is human only", () => {
    const f = setup();
    const a = writeNote(f, f.agentAId, "x");
    const q = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a" });
    expect(() => revertBatch(ctxFor(f, f.agentAId), q.batch_id)).toThrow(CtxdError);
    void a;
  });
});

describe("claim suspension (SPEC v6 section 7.6.2 step 4)", () => {
  it("suspends an active claim on quarantine, and overlap detection ignores it", () => {
    const f = setup();
    const claimed = handleClaim(
      ctxFor(f, f.agentAId),
      claim({ scope: f.scopeName, action: "claim", title: "Task A", paths: ["src/a.ts"] }),
    ) as { lease: { task_id: string } };

    const q = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a" });
    expect(q.suspended_claims).toBe(1);

    const lease = f.db.prepare("SELECT suspended_at FROM leases WHERE task_id = ?").get(claimed.lease.task_id) as { suspended_at: string | null };
    expect(lease.suspended_at).not.toBeNull();

    const result = handleClaim(
      ctxFor(f, f.agentBId),
      claim({ scope: f.scopeName, action: "claim", title: "Task B", paths: ["src/a.ts"] }),
    ) as { lease: { state: string }; overlaps: unknown[] };
    expect(result.lease.state).toBe("active");
    expect(result.overlaps).toEqual([]); // the suspended lease no longer counts as an overlap
  });

  it("resumes a suspended claim on release, so overlap detection sees it again", () => {
    const f = setup();
    const claimed = handleClaim(
      ctxFor(f, f.agentAId),
      claim({ scope: f.scopeName, action: "claim", title: "Task A", paths: ["src/a.ts"] }),
    ) as { lease: { task_id: string } };
    const q = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a" });
    releaseBatch(ctxFor(f, f.humanId), q.batch_id);

    const lease = f.db.prepare("SELECT suspended_at, state FROM leases WHERE task_id = ?").get(claimed.lease.task_id) as {
      suspended_at: string | null;
      state: string;
    };
    expect(lease.suspended_at).toBeNull();
    expect(lease.state).toBe("active");

    const result = handleClaim(
      ctxFor(f, f.agentBId),
      claim({ scope: f.scopeName, action: "claim", title: "Task B", paths: ["src/a.ts"] }),
    ) as { overlaps: { holder: string }[] };
    expect(result.overlaps).toHaveLength(1);
  });

  it("releases a suspended claim (changed_files unknown) once its batch is reverted", () => {
    const f = setup();
    const claimed = handleClaim(
      ctxFor(f, f.agentAId),
      claim({ scope: f.scopeName, action: "claim", title: "Task A", paths: ["src/a.ts"] }),
    ) as { lease: { task_id: string } };
    const q = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a" });
    revertBatch(ctxFor(f, f.humanId), q.batch_id);

    const lease = f.db.prepare("SELECT state, changed_files, drift FROM leases WHERE task_id = ?").get(claimed.lease.task_id) as {
      state: string;
      changed_files: string | null;
      drift: string | null;
    };
    expect(lease.state).toBe("released");
    expect(lease.changed_files).toBeNull();
    expect(lease.drift).toBeNull();
  });
});

function dumpHash(db: Database.Database): string {
  const rows = (table: string, order: string) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all());
  const dump = [rows("entries", "entry_id"), rows("relations", "link_id"), rows("leases", "task_id")].join("\u0000");
  return createHash("sha256").update(dump).digest("hex");
}

describe("ctxd rebuild replays quarantine/revert/release events (AGENTS.md: sync/apply changes need convergence tests)", () => {
  it("is deterministic across random sequences of edits followed by quarantine and either revert or release (property test)", () => {
    fc.assert(
      fc.property(
        fc.record({
          updates: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 3 }),
          finish: fc.constantFrom<"revert" | "release">("revert", "release"),
        }),
        ({ updates, finish }) => {
          const f = setup();
          let last = writeNote(f, f.agentAId, "v0");
          for (const body of updates) {
            last = writeNote(f, f.agentAId, body || "x", { id: last.id, expectedRev: last.rev });
          }

          const q = openQuarantine(ctxFor(f, f.humanId), { client: "agent-a" });
          if (finish === "revert") revertBatch(ctxFor(f, f.humanId), q.batch_id);
          else releaseBatch(ctxFor(f, f.humanId), q.batch_id);

          const before = dumpHash(f.db);
          rebuild(f.db);
          const after = dumpHash(f.db);
          return after === before;
        },
      ),
      { numRuns: 25 },
    );
  });
});
