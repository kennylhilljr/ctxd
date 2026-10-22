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
import { rebuild } from "../../src/store/rebuild.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-write-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  clock: HlcClock;
  nodeId: string;
  agentId: string;
  agentName: string;
  humanId: string;
  notesScopeId: string;
  privateAScopeId: string;
}

/** A node with: a 'notes' scope the agent's pool can write to, and a pooled 'private-a' scope it cannot. */
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
  const agentName = "codex@laptop";
  db.prepare(
    "INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, ?, 'openai', ?, ?, ?)",
  ).run(agentId, agentName, nodeId, newId(), now());

  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'write')").run(notesScopeId);

  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-private', 'pool-private', ?)").run(now());
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-private', ?, 'write')").run(privateAScopeId);

  return { db, clock: new HlcClock(nodeId), nodeId, agentId, agentName, humanId, notesScopeId, privateAScopeId };
}

/** One shared clock per fixture (a real session owns exactly one), so events it produces stay monotonic. */
function ctxFor(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId };
}

function requestId(): string {
  return newId();
}

describe("writeEntry (SPEC v6 section 6)", () => {
  it("creates an active note as the human client", () => {
    const f = setup();
    const result = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "note",
      title: "Sample note",
      body: "This is a sample note.",
      request_id: requestId(),
    } as never);
    expect("held" in result).toBe(false);
    if ("held" in result) return;
    expect(result.status).toBe("active");
    const row = f.db.prepare("SELECT title, summary, status FROM entries WHERE entry_id = ?").get(result.id) as {
      title: string;
      summary: string;
      status: string;
    };
    expect(row.title).toBe("Sample note");
    expect(row.summary).toBe("This is a sample note.");
  });

  it("creates a decision proposed by default for an agent", () => {
    const f = setup();
    const result = writeEntry(ctxFor(f, f.agentId), {
      scope: "notes",
      kind: "decision",
      title: "Use SQLite",
      body: "We will use SQLite for local storage.",
      request_id: requestId(),
    } as never);
    expect("held" in result).toBe(false);
    if ("held" in result) return;
    expect(result.status).toBe("proposed");
  });

  it("rejects a content update on an immutable kind", () => {
    const f = setup();
    const created = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Use SQLite",
      body: "Body.",
      request_id: requestId(),
    } as never);
    if ("held" in created) throw new Error("unexpected hold");
    expect(() =>
      writeEntry(ctxFor(f, f.humanId), {
        scope: "notes",
        kind: "decision",
        title: "Use SQLite",
        body: "Changed body.",
        id: created.id,
        expected_rev: created.rev,
        request_id: requestId(),
      } as never),
    ).toThrow(/IMMUTABLE_KIND|cannot be updated/);
  });

  it("detects optimistic concurrency conflicts", () => {
    const f = setup();
    const created = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "note",
      title: "Note",
      body: "v1",
      request_id: requestId(),
    } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const first = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "note",
      title: "Note",
      body: "v2",
      id: created.id,
      expected_rev: created.rev,
      request_id: requestId(),
    } as never);
    expect("held" in first).toBe(false);

    try {
      writeEntry(ctxFor(f, f.humanId), {
        scope: "notes",
        kind: "note",
        title: "Note",
        body: "v3 from a stale read",
        id: created.id,
        expected_rev: created.rev, // the same stale rev the first update also started from
        request_id: requestId(),
      } as never);
      expect.fail("expected REV_CONFLICT");
    } catch (err) {
      expect(err).toBeInstanceOf(CtxdError);
      expect((err as CtxdError).code).toBe("REV_CONFLICT");
    }
  });

  it("is idempotent: the same request_id and input returns the same result without a second write", () => {
    const f = setup();
    const reqId = requestId();
    const input = { scope: "notes", kind: "note", title: "Once", body: "Only once.", request_id: reqId } as never;
    const first = writeEntry(ctxFor(f, f.humanId), input);
    const second = writeEntry(ctxFor(f, f.humanId), input);
    expect(first).toEqual(second);
    const count = f.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE title = 'Once'").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("refuses to reuse a request_id with different input", () => {
    const f = setup();
    const reqId = requestId();
    writeEntry(ctxFor(f, f.humanId), { scope: "notes", kind: "note", title: "A", body: "a", request_id: reqId } as never);
    try {
      writeEntry(ctxFor(f, f.humanId), { scope: "notes", kind: "note", title: "B", body: "b", request_id: reqId } as never);
      expect.fail("expected IDEMPOTENCY_MISMATCH");
    } catch (err) {
      expect((err as CtxdError).code).toBe("IDEMPOTENCY_MISMATCH");
    }
  });

  it("rejects agent writes that match a secret detector, and records a rejection row", () => {
    const f = setup();
    try {
      writeEntry(ctxFor(f, f.agentId), {
        scope: "notes",
        kind: "note",
        title: "Credentials",
        body: "AKIAABCDEFGHIJKLMNOP is our access key",
        request_id: requestId(),
      } as never);
      expect.fail("expected REDACTED_SECRET");
    } catch (err) {
      expect((err as CtxdError).code).toBe("REDACTED_SECRET");
    }
    const rejection = f.db.prepare("SELECT code FROM rejections WHERE client_id = ?").get(f.agentId) as { code: string };
    expect(rejection.code).toBe("REDACTED_SECRET");
    const count = f.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("holds a write to a scope outside the client's pools and opens an access request", () => {
    const f = setup();
    const result = writeEntry(ctxFor(f, f.agentId), {
      scope: "private-a",
      kind: "note",
      title: "Can't write here directly",
      body: "Held for review.",
      request_id: requestId(),
    } as never);
    if (!("held" in result)) throw new Error("expected a held result");
    expect(result.held_in).toBe(`_hold.${f.agentName}`);
    const request = f.db.prepare("SELECT client_id, scope_id, attempts FROM access_requests WHERE request_id = ?").get(
      result.access_request,
    ) as { client_id: string; scope_id: string; attempts: number };
    expect(request.client_id).toBe(f.agentId);
    expect(request.scope_id).toBe(f.privateAScopeId);
    expect(request.attempts).toBe(1);
  });

  it("holds a write to a scope that belongs to no pool, opening an access_requests row with pool_ids '[]' (SPEC v7 section 6 step 1)", () => {
    const f = setup();
    const noPoolScopeId = newId();
    f.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'unassigned', ?)").run(noPoolScopeId, now());

    const result = writeEntry(ctxFor(f, f.agentId), {
      scope: "unassigned",
      kind: "note",
      title: "No pool grants this scope",
      body: "Held for review.",
      request_id: requestId(),
    } as never);
    if (!("held" in result)) throw new Error("expected a held result");
    expect(result.access_request).not.toBe("");
    const request = f.db.prepare("SELECT client_id, scope_id, pool_ids FROM access_requests WHERE request_id = ?").get(
      result.access_request,
    ) as { client_id: string; scope_id: string; pool_ids: string };
    expect(request.client_id).toBe(f.agentId);
    expect(request.scope_id).toBe(noPoolScopeId);
    expect(request.pool_ids).toBe("[]");
  });

  it("replays a held write's idempotent retry without bumping access_requests again", () => {
    const f = setup();
    const reqId = requestId();
    const input = { scope: "private-a", kind: "note", title: "Held", body: "Held body.", request_id: reqId } as never;
    const first = writeEntry(ctxFor(f, f.agentId), input);
    const second = writeEntry(ctxFor(f, f.agentId), input);
    expect(first).toEqual(second);
    if (!("held" in first)) throw new Error("expected a held result");
    const request = f.db.prepare("SELECT attempts FROM access_requests WHERE request_id = ?").get(first.access_request) as {
      attempts: number;
    };
    expect(request.attempts).toBe(1);
  });

  it("rejects an invalid SKILL.md body", () => {
    const f = setup();
    try {
      writeEntry(ctxFor(f, f.humanId), {
        scope: "notes",
        kind: "skill",
        title: "my-skill",
        body: "not a valid skill body",
        request_id: requestId(),
      } as never);
      expect.fail("expected VALIDATION");
    } catch (err) {
      expect((err as CtxdError).code).toBe("VALIDATION");
    }
  });

  it("marks the superseded entry and records a relation", () => {
    const f = setup();
    const original = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Use SQLite",
      body: "Original.",
      request_id: requestId(),
    } as never);
    if ("held" in original) throw new Error("unexpected hold");

    const replacement = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Use SQLite with WAL",
      body: "Replacement.",
      supersedes: original.ref,
      links: [{ type: "supersedes", ref: original.ref }],
      request_id: requestId(),
    } as never);
    if ("held" in replacement) throw new Error("unexpected hold");

    const originalRow = f.db.prepare("SELECT status, created_hlc, updated_hlc FROM entries WHERE entry_id = ?").get(original.id) as {
      status: string;
      created_hlc: string;
      updated_hlc: string;
    };
    expect(originalRow.status).toBe("superseded");
    // Regression: the status-event handler used to leave updated_hlc at its creation-time
    // value, making the superseded entry look like it was active for zero time in signals.
    expect(originalRow.updated_hlc).not.toBe(originalRow.created_hlc);
    const relation = f.db.prepare("SELECT type, target FROM relations WHERE entry_id = ?").get(replacement.id) as {
      type: string;
      target: string;
    };
    expect(relation.type).toBe("supersedes");
    expect(relation.target).toBe(original.ref);
  });

  it("refuses to supersede an entry in a scope the client has no access to (regression: access-control bypass)", () => {
    const f = setup();
    const privateEntry = writeEntry(ctxFor(f, f.humanId), {
      scope: "private-a",
      kind: "decision",
      title: "Private decision",
      body: "Only the human and pool-private can see this.",
      request_id: requestId(),
    } as never);
    if ("held" in privateEntry) throw new Error("unexpected hold");

    try {
      writeEntry(ctxFor(f, f.agentId), {
        scope: "notes",
        kind: "decision",
        title: "Trying to supersede something I can't see",
        body: "Body.",
        supersedes: privateEntry.ref,
        request_id: requestId(),
      } as never);
      expect.fail("expected SCOPE_FORBIDDEN");
    } catch (err) {
      expect((err as CtxdError).code).toBe("SCOPE_FORBIDDEN");
    }
    const row = f.db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(privateEntry.id) as { status: string };
    expect(row.status).toBe("active");
  });

  it("rejects superseding an entry that's already superseded by someone else", () => {
    const f = setup();
    const original = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Original",
      body: "Body.",
      request_id: requestId(),
    } as never);
    if ("held" in original) throw new Error("unexpected hold");
    writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "First replacement",
      body: "Body.",
      supersedes: original.ref,
      request_id: requestId(),
    } as never);

    try {
      writeEntry(ctxFor(f, f.humanId), {
        scope: "notes",
        kind: "decision",
        title: "Second replacement",
        body: "Body.",
        supersedes: original.ref,
        request_id: requestId(),
      } as never);
      expect.fail("expected VALIDATION");
    } catch (err) {
      expect((err as CtxdError).code).toBe("VALIDATION");
    }
  });

  it("preserves the existing body on an update that only changes the title (regression: omitted body wiped it)", () => {
    const f = setup();
    const created = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "note",
      title: "Original title",
      body: "Body that must survive.",
      request_id: requestId(),
    } as never);
    if ("held" in created) throw new Error("unexpected hold");

    writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "note",
      title: "New title",
      id: created.id,
      expected_rev: created.rev,
      request_id: requestId(),
    } as never);

    const row = f.db.prepare("SELECT title, body FROM entries WHERE entry_id = ?").get(created.id) as { title: string; body: string };
    expect(row.title).toBe("New title");
    expect(row.body).toBe("Body that must survive.");
  });

  it("persists skill_name from the SKILL.md frontmatter (regression: parseSkill's result was discarded)", () => {
    const f = setup();
    const body = "---\nname: deploy-runbook\ndescription: How to deploy.\n---\nSteps here.";
    const result = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "skill",
      title: "deploy-runbook",
      body,
      request_id: requestId(),
    } as never);
    if ("held" in result) throw new Error("unexpected hold");
    const row = f.db.prepare("SELECT skill_name FROM entries WHERE entry_id = ?").get(result.id) as { skill_name: string };
    expect(row.skill_name).toBe("deploy-runbook");
  });

  it("a human write of an always-reviewed kind is still active (regression: agent-only rule applied to human writes)", () => {
    const f = setup();
    const result = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "preference",
      title: "Always use pnpm",
      body: "Prefer pnpm over npm.",
      request_id: requestId(),
    } as never);
    expect("held" in result).toBe(false);
    if ("held" in result) return;
    expect(result.status).toBe("active");
  });
});

describe("writeEntry's review_after defaults (Knowledge model 3.1, SPEC 7.6.7)", () => {
  function reviewAfter(f: Fixture, entryId: string): string | null {
    return (f.db.prepare("SELECT review_after FROM entries WHERE entry_id = ?").get(entryId) as { review_after: string | null }).review_after;
  }

  /** The exact ISO date defaultReviewAfter would compute right now, within the same millisecond's date truncation defaultReviewAfter itself uses. */
  function expectedDate(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  }

  it("sets status to 14 days, handoff to 30, fact and lesson to 180, preference to 365", () => {
    const f = setup();
    const cases: [kind: string, days: number][] = [
      ["status", 14],
      ["handoff", 30],
      ["fact", 180],
      ["lesson", 180],
      ["preference", 365],
    ];
    for (const [kind, days] of cases) {
      const result = writeEntry(ctxFor(f, f.humanId), { scope: "notes", kind, title: kind, body: "x", request_id: requestId() } as never);
      if ("held" in result) throw new Error("unexpected hold");
      expect(reviewAfter(f, result.id)).toBe(expectedDate(days));
    }
  });

  it("never sets review_after for kinds with no default, e.g. decision and convention", () => {
    const f = setup();
    for (const kind of ["decision", "convention", "note", "pointer", "task", "skill"]) {
      const input = kind === "skill" ? { scope: "notes", kind, title: "a-skill", body: "---\nname: a-skill\ndescription: d\n---\nbody", request_id: requestId() } : { scope: "notes", kind, title: kind, body: "x", request_id: requestId() };
      const result = writeEntry(ctxFor(f, f.humanId), input as never);
      if ("held" in result) throw new Error("unexpected hold");
      expect(reviewAfter(f, result.id)).toBeNull();
    }
  });
});

function dumpHash(db: Database.Database): string {
  const rows = (table: string, order: string) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all());
  const dump = [rows("entries", "entry_id"), rows("relations", "link_id"), rows("signals", "entry_id, source")].join("\u0000");
  return createHash("sha256").update(dump).digest("hex");
}

describe("ctxd rebuild (SPEC v6 section 13)", () => {
  it("reproduces identical materialized state from the event log", () => {
    const f = setup();
    const a = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Decision A",
      body: "Body A.",
      request_id: requestId(),
    } as never);
    if ("held" in a) throw new Error("unexpected hold");
    writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Decision B",
      body: "Body B.",
      supersedes: a.ref,
      request_id: requestId(),
    } as never);
    writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "note",
      title: "Note",
      body: "v1",
      request_id: requestId(),
    } as never);

    const before = dumpHash(f.db);
    rebuild(f.db);
    const after = dumpHash(f.db);
    expect(after).toBe(before);
  });

  it("replays entries.origin from the event log (W7), since provenance is carried in the create payload", () => {
    const f = setup();
    const written = writeEntry(
      { ...ctxFor(f, f.humanId), origin: { source: "mobile-inbox", captured_at: "2026-10-20T12:00:00.000Z", client_ref: "msg_123" } },
      { scope: "notes", kind: "note", title: "Captured on the phone", body: "Body.", request_id: requestId() } as never,
    );
    if ("held" in written) throw new Error("unexpected hold");

    const origin = () => (f.db.prepare("SELECT origin FROM entries WHERE entry_id = ?").get(written.id) as { origin: string | null }).origin;
    const beforeRebuild = origin();
    expect(JSON.parse(beforeRebuild as string)).toEqual({ source: "mobile-inbox", captured_at: "2026-10-20T12:00:00.000Z", client_ref: "msg_123" });

    rebuild(f.db);
    expect(origin()).toBe(beforeRebuild);
  });
});

describe("entries.origin (W7)", () => {
  it("is NULL for an ordinary write, which created_by already explains", () => {
    const f = setup();
    const written = writeEntry(ctxFor(f, f.humanId), { scope: "notes", kind: "note", title: "Ordinary", body: "Body.", request_id: requestId() } as never);
    if ("held" in written) throw new Error("unexpected hold");
    const row = f.db.prepare("SELECT origin FROM entries WHERE entry_id = ?").get(written.id) as { origin: string | null };
    expect(row.origin).toBeNull();
  });

  it("is recorded at create and left alone by a later update, even one with no origin in its context", () => {
    const f = setup();
    const created = writeEntry(
      { ...ctxFor(f, f.humanId), origin: { source: "mobile-inbox", captured_at: "2026-10-20T12:00:00.000Z" } },
      { scope: "notes", kind: "note", title: "Captured", body: "v1", request_id: requestId() } as never,
    );
    if ("held" in created) throw new Error("unexpected hold");

    const updated = writeEntry(ctxFor(f, f.humanId), {
      scope: "notes",
      kind: "note",
      id: created.id,
      expected_rev: created.rev,
      title: "Captured, edited",
      body: "v2",
      request_id: requestId(),
    } as never);
    if ("held" in updated) throw new Error("unexpected hold");

    const row = f.db.prepare("SELECT origin, body FROM entries WHERE entry_id = ?").get(created.id) as { origin: string | null; body: string };
    expect(row.body).toBe("v2");
    expect(JSON.parse(row.origin as string)).toEqual({ source: "mobile-inbox", captured_at: "2026-10-20T12:00:00.000Z" });
  });

  it("is deterministic across random sequences of creates and updates (property test)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ title: fc.string({ minLength: 1, maxLength: 30 }), body: fc.string({ minLength: 1, maxLength: 50 }) }), {
          minLength: 1,
          maxLength: 8,
        }),
        (ops) => {
          const f = setup();
          let lastId: string | undefined;
          let lastRev: string | undefined;
          for (const op of ops) {
            const result = writeEntry(ctxFor(f, f.humanId), {
              scope: "notes",
              kind: "note",
              title: op.title || "untitled",
              body: op.body || "empty",
              ...(lastId ? { id: lastId, expected_rev: lastRev } : {}),
              request_id: requestId(),
            } as never);
            if ("held" in result) throw new Error("unexpected hold");
            lastId = result.id;
            lastRev = result.rev;
          }
          const before = dumpHash(f.db);
          rebuild(f.db);
          const after = dumpHash(f.db);
          return after === before;
        },
      ),
      { numRuns: 25 },
    );
  });

  // AGENTS.md: "every change to sync or apply comes with property tests for convergence."
  // This interleaves content updates with supersede (status-event) transitions, the path
  // the updated_hlc bug above lived in and the prior property test above never touched.
  it("is deterministic across random sequences including supersede/status transitions (property test)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom<"note" | "supersede">("note", "supersede"),
            title: fc.string({ minLength: 1, maxLength: 30 }),
            body: fc.string({ minLength: 1, maxLength: 50 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (ops) => {
          const f = setup();
          let lastNoteId: string | undefined;
          let lastNoteRev: string | undefined;
          let lastDecisionRef: string | undefined;
          for (const op of ops) {
            if (op.kind === "note") {
              const result = writeEntry(ctxFor(f, f.humanId), {
                scope: "notes",
                kind: "note",
                title: op.title || "untitled",
                body: op.body || "empty",
                ...(lastNoteId ? { id: lastNoteId, expected_rev: lastNoteRev } : {}),
                request_id: requestId(),
              } as never);
              if ("held" in result) throw new Error("unexpected hold");
              lastNoteId = result.id;
              lastNoteRev = result.rev;
            } else {
              const result = writeEntry(ctxFor(f, f.humanId), {
                scope: "notes",
                kind: "decision",
                title: op.title || "untitled decision",
                body: op.body || "empty",
                ...(lastDecisionRef ? { supersedes: lastDecisionRef } : {}),
                request_id: requestId(),
              } as never);
              if ("held" in result) throw new Error("unexpected hold");
              lastDecisionRef = result.ref;
            }
          }
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
