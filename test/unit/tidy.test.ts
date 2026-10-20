import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { encodeHlc, HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { findTidyCandidates, applyTidyFinding, type TidyFinding } from "../../src/store/tidy.js";
import { CtxdError } from "../../src/core/errors.js";

/** `ctxd tidy` (SPEC v8 7.6.7, PRD-context-hygiene-v1 section 7). */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-tidy-")), "ctxd.db");
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
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const notesScopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(notesScopeId, now());
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
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, agentId, notesScopeId };
}

function writeCtx(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId };
}

function backdate(f: Fixture, entryId: string, days: number): void {
  const hlc = encodeHlc({ physical: Date.now() - days * 86_400_000, counter: 0, node: f.nodeId });
  f.db.prepare("UPDATE entries SET updated_hlc = ? WHERE entry_id = ?").run(hlc, entryId);
}

function findingFor(findings: TidyFinding[], ref: string): TidyFinding | undefined {
  return findings.find((f) => f.ref === ref || f.other === ref);
}

describe("findTidyCandidates", () => {
  it("finds a superseded entry older than 90 days, to archive", () => {
    const f = setup();
    const original = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "Old decision", body: "x", request_id: newId() } as never);
    if ("held" in original) throw new Error("unexpected hold");
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "New decision", body: "y", supersedes: original.ref, request_id: newId() } as never);
    backdate(f, original.id, 100);

    const findings = findTidyCandidates(f.db);
    const found = findingFor(findings, original.ref);
    expect(found?.kind).toBe("archive-superseded");
  });

  it("does not flag a superseded entry less than 90 days old", () => {
    const f = setup();
    const original = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "Recent decision", body: "x", request_id: newId() } as never);
    if ("held" in original) throw new Error("unexpected hold");
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "Replacement", body: "y", supersedes: original.ref, request_id: newId() } as never);

    expect(findingFor(findTidyCandidates(f.db), original.ref)).toBeUndefined();
  });

  it("finds a low-importance, old, long-unread active entry, to archive", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Stale note", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    // 500 days (recency half-life is 90) pushes a "note" kind's importance (weight 0.4) below
    // the 0.15 archive threshold even with zero links and zero reads.
    backdate(f, created.id, 500);

    const findings = findTidyCandidates(f.db);
    const found = findingFor(findings, created.ref);
    expect(found?.kind).toBe("archive-stale");
  });

  it("does not flag a recently-read stale-looking entry", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Read note", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    backdate(f, created.id, 200);
    f.db.prepare("INSERT INTO read_stats (entry_id, last_read_at, reads, briefed) VALUES (?, ?, 1, 0)").run(created.id, now());

    expect(findingFor(findTidyCandidates(f.db), created.ref)).toBeUndefined();
  });

  it("finds an entry past its review_after date, to review", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "status", title: "Status", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    f.db.prepare("UPDATE entries SET review_after = '2000-01-01' WHERE entry_id = ?").run(created.id);

    const found = findingFor(findTidyCandidates(f.db), created.ref);
    expect(found?.kind).toBe("review-due");
  });

  it("finds two active entries with near-identical titles, as a duplicate pair", () => {
    const f = setup();
    // Jaccard similarity over word sets: these differ in exactly one of seven unique words
    // ("to" repeats in A, counted once), giving 6/7 ≈ 0.857, comfortably over the 0.8 threshold.
    const a = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "fact", title: "Decision to migrate the database to Postgres", body: "x", request_id: newId() } as never);
    const b = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "fact", title: "Decision to migrate the database into Postgres", body: "y", request_id: newId() } as never);
    if ("held" in a || "held" in b) throw new Error("unexpected hold");

    const findings = findTidyCandidates(f.db);
    const dup = findings.find((x) => x.kind === "duplicate" && (x.ref === a.ref || x.ref === b.ref));
    expect(dup).toBeDefined();
  });

  it("finds a flag open longer than a week, to close", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Flagged note", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    const oldHlc = encodeHlc({ physical: Date.now() - 10 * 86_400_000, counter: 0, node: f.nodeId });
    f.db
      .prepare("INSERT INTO flags (flag_id, entry_id, problem, reason, flagged_by, flagged_hlc) VALUES (?, ?, 'stale', 'looks stale', ?, ?)")
      .run(newId(), created.id, f.agentId, oldHlc);
    f.db.prepare("UPDATE entries SET status = 'flagged' WHERE entry_id = ?").run(created.id); // what the real 'flag' event would also set

    const found = findingFor(findTidyCandidates(f.db), created.ref);
    expect(found?.kind).toBe("stale-flag");
  });

  it("filters by scope when a scopeId is given", () => {
    const f = setup();
    const otherScopeId = newId();
    f.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'other', ?)").run(otherScopeId, now());
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "In notes", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    backdate(f, created.id, 500);

    expect(findingFor(findTidyCandidates(f.db, otherScopeId), created.ref)).toBeUndefined();
    expect(findingFor(findTidyCandidates(f.db, f.notesScopeId), created.ref)).toBeDefined();
  });
});

describe("applyTidyFinding", () => {
  it("archives an entry for an archive-superseded or archive-stale finding", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    backdate(f, created.id, 500);
    const finding = findingFor(findTidyCandidates(f.db), created.ref)!;

    const result = applyTidyFinding({ db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId }, finding);
    expect(result.action).toBe("archived");
    const status = (f.db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(created.id) as { status: string }).status;
    expect(status).toBe("archived");
  });

  it("snoozes review_after forward for a review-due finding", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "status", title: "S", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    f.db.prepare("UPDATE entries SET review_after = '2000-01-01' WHERE entry_id = ?").run(created.id);
    const finding = findingFor(findTidyCandidates(f.db), created.ref)!;

    applyTidyFinding({ db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId }, finding);
    const after = (f.db.prepare("SELECT review_after FROM entries WHERE entry_id = ?").get(created.id) as { review_after: string }).review_after;
    expect(after > "2000-01-01").toBe(true);
    expect(findingFor(findTidyCandidates(f.db), created.ref)).toBeUndefined();
  });

  it("unflags an entry for a stale-flag finding", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    const oldHlc = encodeHlc({ physical: Date.now() - 10 * 86_400_000, counter: 0, node: f.nodeId });
    f.db
      .prepare("INSERT INTO flags (flag_id, entry_id, problem, reason, flagged_by, flagged_hlc) VALUES (?, ?, 'stale', 'looks stale', ?, ?)")
      .run(newId(), created.id, f.agentId, oldHlc);
    f.db.prepare("UPDATE entries SET status = 'flagged' WHERE entry_id = ?").run(created.id); // what the real 'flag' event would also set
    const finding = findingFor(findTidyCandidates(f.db), created.ref)!;

    const result = applyTidyFinding({ db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId }, finding);
    expect(result.action).toContain("unflagged");
  });

  it("never applies a duplicate finding automatically", () => {
    const f = setup();
    const a = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "fact", title: "Decision to migrate the database to Postgres", body: "x", request_id: newId() } as never);
    const b = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "fact", title: "Decision to migrate the database into Postgres", body: "y", request_id: newId() } as never);
    if ("held" in a || "held" in b) throw new Error("unexpected hold");
    const finding = findTidyCandidates(f.db).find((x) => x.kind === "duplicate")!;

    expect(() => applyTidyFinding({ db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId }, finding)).toThrow(CtxdError);
    const statusA = (f.db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(a.id) as { status: string }).status;
    expect(statusA).toBe("active"); // untouched
  });

  it("is human only", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    backdate(f, created.id, 500);
    const finding = findingFor(findTidyCandidates(f.db), created.ref)!;

    expect(() => applyTidyFinding({ db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.agentId }, finding)).toThrow(/human only/);
  });
});
