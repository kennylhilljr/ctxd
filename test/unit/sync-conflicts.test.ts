import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { encodeHlc, HlcClock } from "../../src/core/hlc.js";
import { makeRev, newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { buildReviewReport, resolveEntry } from "../../src/store/review.js";
import { flagEntry } from "../../src/store/flag.js";
import { applyEvent, type WireEvent } from "../../src/sync/apply.js";

/** Tests for Spec v8 7.3's concurrent apply and 7.4's conflict policies, via sync's applyEvent. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-sync-conflicts-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
  humanId: string;
  agentId: string;
  scopeId: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(scopeId, now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now());
  const agentId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-a', 'openai', ?, ?, ?)").run(agentId, nodeId, newId(), now());
  return { db, nodeId, humanId, agentId, scopeId };
}

function wctx(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: new HlcClock(f.nodeId), nodeId: f.nodeId, clientId };
}

function hlcAt(physical: number, node: string): string {
  return encodeHlc({ physical, counter: 0, node });
}

/** A synthetic "update" WireEvent concurrent with `parentRev`, as if it arrived from a remote node. */
function concurrentUpdate(f: Fixture, args: { entryId: string; parentRev: string; clientId: string; hlc: string; payload: Record<string, unknown> }): WireEvent {
  const eventId = newId();
  return {
    eventId,
    originNode: newId(),
    originSeq: 1,
    hlc: args.hlc,
    scopeId: f.scopeId,
    entryId: args.entryId,
    op: "update",
    part: "content",
    parentRevs: [args.parentRev],
    rev: makeRev(2, eventId),
    clientId: args.clientId,
    sessionRef: null,
    requestId: null,
    requestHash: null,
    payload: args.payload,
    prev: null,
  };
}

function concurrentStatus(f: Fixture, args: { entryId: string; parentRev: string; clientId: string; hlc: string; status: string }): WireEvent {
  const eventId = newId();
  return {
    eventId,
    originNode: newId(),
    originSeq: 1,
    hlc: args.hlc,
    scopeId: f.scopeId,
    entryId: args.entryId,
    op: "status",
    part: "status",
    parentRevs: [args.parentRev],
    rev: makeRev(2, eventId),
    clientId: args.clientId,
    sessionRef: null,
    requestId: null,
    requestHash: null,
    payload: { status: args.status },
    prev: { status: "active" },
  };
}

describe("content conflicts (Spec 7.4): convention/fact/lesson/note/task moves to conflicted", () => {
  it("the later-HLC side wins as head, the earlier side is kept as a conflict sibling, and ctxd review lists it", () => {
    const f = setup();
    const created = writeEntry(wctx(f, f.humanId), { scope: "notes", kind: "fact", title: "Original", body: "v0", request_id: newId() } as never) as {
      id: string;
      ref: string;
      rev: string;
    };

    const earlier = concurrentUpdate(f, { entryId: created.id, parentRev: created.rev, clientId: f.humanId, hlc: hlcAt(1000, f.nodeId), payload: { body: "from node A" } });
    const later = concurrentUpdate(f, { entryId: created.id, parentRev: created.rev, clientId: f.humanId, hlc: hlcAt(2000, f.nodeId), payload: { body: "from node B" } });

    applyEvent(f.db, earlier);
    const result = applyEvent(f.db, later);
    expect(result.outcome).toBe("conflict-resolved");

    const row = f.db.prepare("SELECT body, status, content_rev FROM entries WHERE entry_id = ?").get(created.id) as { body: string; status: string; content_rev: string };
    expect(row.body).toBe("from node B"); // later HLC is head
    expect(row.status).toBe("conflicted");
    expect(row.content_rev).toBe(later.rev);

    const siblings = f.db.prepare("SELECT rev, reason FROM entry_siblings WHERE entry_id = ?").all(created.id) as { rev: string; reason: string }[];
    expect(siblings).toEqual([{ rev: earlier.rev, reason: "conflict" }]);

    const report = buildReviewReport(f.db);
    expect(report.conflicted.map((r) => r.ref)).toContain(created.ref);
  });

  it("converges to the same outcome regardless of which concurrent event is applied first", () => {
    function run(order: "a-then-b" | "b-then-a"): { body: string; siblingReasons: string[] } {
      const f = setup();
      const created = writeEntry(wctx(f, f.humanId), { scope: "notes", kind: "convention", title: "C", body: "v0", request_id: newId() } as never) as { id: string; rev: string };
      const a = concurrentUpdate(f, { entryId: created.id, parentRev: created.rev, clientId: f.humanId, hlc: hlcAt(1000, f.nodeId), payload: { body: "A" } });
      const b = concurrentUpdate(f, { entryId: created.id, parentRev: created.rev, clientId: f.humanId, hlc: hlcAt(2000, f.nodeId), payload: { body: "B" } });
      if (order === "a-then-b") {
        applyEvent(f.db, a);
        applyEvent(f.db, b);
      } else {
        applyEvent(f.db, b);
        applyEvent(f.db, a);
      }
      const row = f.db.prepare("SELECT body FROM entries WHERE entry_id = ?").get(created.id) as { body: string };
      const siblingReasons = (f.db.prepare("SELECT reason FROM entry_siblings WHERE entry_id = ?").all(created.id) as { reason: string }[]).map((r) => r.reason);
      return { body: row.body, siblingReasons };
    }

    const forward = run("a-then-b");
    const backward = run("b-then-a");
    expect(forward).toEqual(backward);
    expect(forward.body).toBe("B"); // later HLC wins either way
  });
});

describe("content conflicts (Spec 7.4): status/brief kinds are last-writer-wins, not conflicted", () => {
  it("records the loser as a sibling with reason lww, leaves status alone, and ctxd review lists it as auto-resolved", () => {
    const f = setup();
    const created = writeEntry(wctx(f, f.humanId), { scope: "notes", kind: "brief", title: "Daily", body: "v0", request_id: newId() } as never) as {
      id: string;
      ref: string;
      rev: string;
    };

    const earlier = concurrentUpdate(f, { entryId: created.id, parentRev: created.rev, clientId: f.humanId, hlc: hlcAt(1000, f.nodeId), payload: { body: "stale" } });
    const later = concurrentUpdate(f, { entryId: created.id, parentRev: created.rev, clientId: f.humanId, hlc: hlcAt(2000, f.nodeId), payload: { body: "fresh" } });

    applyEvent(f.db, later);
    applyEvent(f.db, earlier); // arrives after the event that already beat it

    const row = f.db.prepare("SELECT body, status FROM entries WHERE entry_id = ?").get(created.id) as { body: string; status: string };
    expect(row.body).toBe("fresh");
    expect(row.status).toBe("active"); // lww never moves status to conflicted

    const siblings = f.db.prepare("SELECT reason FROM entry_siblings WHERE entry_id = ?").all(created.id) as { reason: string }[];
    expect(siblings).toEqual([{ reason: "lww" }]);

    const report = buildReviewReport(f.db);
    expect(report.auto_resolved.map((r) => r.ref)).toContain(created.ref);
  });
});

describe("status conflicts (Spec 7.4): a human event wins regardless of HLC", () => {
  it("a human's earlier status event beats an agent's later one", () => {
    const f = setup();
    const created = writeEntry(wctx(f, f.humanId), { scope: "notes", kind: "task", title: "T", body: "b", request_id: newId() } as never) as { id: string; rev: string };
    // The create event's own rev seeds content_rev/status_rev/relations_rev alike (Spec v6 4).
    const humanEvent = concurrentStatus(f, { entryId: created.id, parentRev: created.rev, clientId: f.humanId, hlc: hlcAt(1000, f.nodeId), status: "archived" });
    const agentEvent = concurrentStatus(f, { entryId: created.id, parentRev: created.rev, clientId: f.agentId, hlc: hlcAt(9000, f.nodeId), status: "active" });

    applyEvent(f.db, agentEvent);
    applyEvent(f.db, humanEvent);

    const row = f.db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(created.id) as { status: string };
    expect(row.status).toBe("archived"); // the human event, despite the earlier HLC
  });

  it("between two non-human events, the later HLC wins", () => {
    const f = setup();
    const created = writeEntry(wctx(f, f.humanId), { scope: "notes", kind: "task", title: "T", body: "b", request_id: newId() } as never) as { id: string; rev: string };
    const earlier = concurrentStatus(f, { entryId: created.id, parentRev: created.rev, clientId: f.agentId, hlc: hlcAt(1000, f.nodeId), status: "archived" });
    const later = concurrentStatus(f, { entryId: created.id, parentRev: created.rev, clientId: f.agentId, hlc: hlcAt(2000, f.nodeId), status: "active" });

    applyEvent(f.db, earlier);
    applyEvent(f.db, later);

    const row = f.db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(created.id) as { status: string };
    expect(row.status).toBe("active");
  });
});

describe("clearing a content conflict", () => {
  it("ctxd review --approve returns a conflicted entry to active, reusing the existing resolve path", () => {
    const f = setup();
    const created = writeEntry(wctx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "v0", request_id: newId() } as never) as { id: string; ref: string; rev: string };
    const a = concurrentUpdate(f, { entryId: created.id, parentRev: created.rev, clientId: f.humanId, hlc: hlcAt(1000, f.nodeId), payload: { body: "A" } });
    const b = concurrentUpdate(f, { entryId: created.id, parentRev: created.rev, clientId: f.humanId, hlc: hlcAt(2000, f.nodeId), payload: { body: "B" } });
    applyEvent(f.db, a);
    applyEvent(f.db, b);
    expect((f.db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(created.id) as { status: string }).status).toBe("conflicted");

    const resolved = resolveEntry(wctx(f, f.humanId), created.ref);
    expect(resolved.status).toBe("active");
  });
});

describe("a winning conflict resolution closes open flags, like any other content edit (regression)", () => {
  it("content conflict", () => {
    const f = setup();
    const created = writeEntry(wctx(f, f.humanId), { scope: "notes", kind: "fact", title: "F", body: "v0", request_id: newId() } as never) as { id: string; ref: string; rev: string };
    flagEntry(wctx(f, f.humanId), { ref: created.ref, problem: "stale", reason: "outdated" });
    expect((f.db.prepare("SELECT resolved FROM flags WHERE entry_id = ?").get(created.id) as { resolved: string | null }).resolved).toBeNull();

    // The entry's status flipped to 'flagged' when flagEntry ran; re-read its post-flag content
    // rev as the baseline both concurrent updates build from.
    const flagged = f.db.prepare("SELECT content_rev FROM entries WHERE entry_id = ?").get(created.id) as { content_rev: string };
    const a = concurrentUpdate(f, { entryId: created.id, parentRev: flagged.content_rev, clientId: f.humanId, hlc: hlcAt(1000, f.nodeId), payload: { body: "A" } });
    const b = concurrentUpdate(f, { entryId: created.id, parentRev: flagged.content_rev, clientId: f.humanId, hlc: hlcAt(2000, f.nodeId), payload: { body: "B" } });
    applyEvent(f.db, a);
    applyEvent(f.db, b); // later HLC: wins, and should close the open flag same as an ordinary edit

    const flag = f.db.prepare("SELECT resolved FROM flags WHERE entry_id = ?").get(created.id) as { resolved: string | null };
    expect(flag.resolved).toBe("edit");
  });
});
