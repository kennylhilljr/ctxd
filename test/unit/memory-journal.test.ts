import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { CtxdError } from "../../src/core/errors.js";
import { runRemember } from "../../src/cli/remember.js";
import { runLog } from "../../src/cli/log.js";
import { printJournal } from "../../src/cli/journal.js";
import { printSignals } from "../../src/cli/signals.js";

/**
 * Tests for the M2 memory and journal CLI (SPEC v6 sections 4.3, 11.4, 13): remember, log,
 * journal and signals, built on the existing write path and signal materialization.
 */

process.env.TZ = "UTC";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-memory-journal-")), "ctxd.db");
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
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  db.prepare("INSERT INTO scopes (scope_id, name, kind, created_at) VALUES (?, '_me', 'me', ?)").run(newId(), now());
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(newId(), now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    humanId,
    nodeId,
    newId(),
    now(),
  );
  return { db, clock: new HlcClock(nodeId), nodeId, humanId };
}

/** A WriteContext whose clock reports a fixed instant, for entries that need a specific created_hlc. */
function writeCtxAt(f: Fixture, atMs: number): WriteContext {
  return { db: f.db, clock: new HlcClock(f.nodeId, () => atMs), nodeId: f.nodeId, clientId: f.humanId };
}

let lines: string[] = [];
let errLines: string[] = [];
beforeEach(() => {
  lines = [];
  errLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errLines.push(args.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ctxd remember (CLI)", () => {
  it("creates a _me-scoped entry with the given kind, default scope", () => {
    const f = setup();
    runRemember(f.db, "Prefer tabs over spaces in this repo.", "preference", "_me");

    const row = f.db.prepare("SELECT e.kind, e.title, e.body, e.status FROM entries e JOIN scopes s ON s.scope_id = e.scope_id WHERE s.name = '_me'").get() as {
      kind: string;
      title: string;
      body: string;
      status: string;
    };
    expect(row.kind).toBe("preference");
    expect(row.body).toBe("Prefer tabs over spaces in this repo.");
    expect(row.status).toBe("active"); // written by the human client (SPEC v6 section 6 step 6)
    expect(row.title.length).toBeLessThanOrEqual(60);
  });

  it("records a convention or fact when --kind says so", () => {
    const f = setup();
    runRemember(f.db, "Always run npm run typecheck before committing.", "convention", "_me");
    const row = f.db.prepare("SELECT kind FROM entries").get() as { kind: string };
    expect(row.kind).toBe("convention");
  });
});

describe("ctxd log (CLI)", () => {
  it("creates a journal entry with the given significance in the named scope", () => {
    const f = setup();
    runLog(f.db, "Shipped the sync property tests.", "milestone", "notes");

    const row = f.db.prepare("SELECT kind, significance, body, status FROM entries").get() as {
      kind: string;
      significance: string;
      body: string;
      status: string;
    };
    expect(row.kind).toBe("journal");
    expect(row.significance).toBe("milestone");
    expect(row.body).toBe("Shipped the sync property tests.");
  });

  it("rejects a body over 1,000 characters with a clear error", () => {
    const f = setup();
    const tooLong = "x".repeat(1001);
    expect(() => runLog(f.db, tooLong, "routine", "notes")).toThrow(CtxdError);
    expect(() => runLog(f.db, tooLong, "routine", "notes")).toThrow(/1,000 characters/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
  });

  it("accepts a body of exactly 1,000 characters", () => {
    const f = setup();
    const exact = "x".repeat(1000);
    expect(() => runLog(f.db, exact, "routine", "notes")).not.toThrow();
  });

  it("--resolves adds a resolved link to the given entry", () => {
    const f = setup();
    const blocker = writeEntry(writeCtxAt(f, Date.now()), {
      scope: "notes",
      kind: "journal",
      title: "Blocked",
      body: "Waiting on the fixture.",
      significance: "blocker",
      request_id: newId(),
    } as never);
    if ("held" in blocker) throw new Error("unexpected hold");

    runLog(f.db, "Fixture landed.", "routine", "notes", blocker.ref);

    const rel = f.db.prepare("SELECT type, target FROM relations WHERE type = 'resolved'").get() as { type: string; target: string };
    expect(rel.type).toBe("resolved");
    expect(rel.target).toBe(blocker.ref);
  });

  it("rejects an unparseable --resolves reference", () => {
    const f = setup();
    expect(() => runLog(f.db, "Fixed something.", "routine", "notes", "not-a-ref")).toThrow(/Invalid --resolves/);
  });
});

describe("ctxd journal (CLI)", () => {
  it("filters entries by --day, a single calendar day", () => {
    const f = setup();
    const dayStart = Date.parse("2026-10-18T00:00:00Z");
    writeEntry(writeCtxAt(f, Date.parse("2026-10-17T12:00:00Z")), {
      scope: "notes", kind: "journal", title: "J", body: "Yesterday entry.", request_id: newId(),
    } as never);
    writeEntry(writeCtxAt(f, dayStart + 8 * 3_600_000), {
      scope: "notes", kind: "journal", title: "J", body: "Today entry.", request_id: newId(),
    } as never);
    writeEntry(writeCtxAt(f, Date.parse("2026-10-19T01:00:00Z")), {
      scope: "notes", kind: "journal", title: "J", body: "Tomorrow entry.", request_id: newId(),
    } as never);

    printJournal(f.db, "notes", "2026-10-18", undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Today entry.");
  });

  it("includes the last millisecond of the day and excludes the first millisecond of the next (day boundary)", () => {
    const f = setup();
    writeEntry(writeCtxAt(f, Date.parse("2026-10-18T23:59:59.999Z")), {
      scope: "notes", kind: "journal", title: "J", body: "Last ms of day.", request_id: newId(),
    } as never);
    writeEntry(writeCtxAt(f, Date.parse("2026-10-19T00:00:00.000Z")), {
      scope: "notes", kind: "journal", title: "J", body: "First ms of next day.", request_id: newId(),
    } as never);

    printJournal(f.db, "notes", "2026-10-18", undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Last ms of day.");
  });

  it("filters entries by --since, a relative age", () => {
    const f = setup();
    const nowMs = Date.now();
    writeEntry(writeCtxAt(f, nowMs - 10 * 86_400_000), {
      scope: "notes", kind: "journal", title: "J", body: "Ten days ago.", request_id: newId(),
    } as never);
    writeEntry(writeCtxAt(f, nowMs - 1 * 86_400_000), {
      scope: "notes", kind: "journal", title: "J", body: "One day ago.", request_id: newId(),
    } as never);

    printJournal(f.db, "notes", undefined, "2d");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("One day ago.");
  });

  it("reads across every scope when none is given", () => {
    const f = setup();
    writeEntry(writeCtxAt(f, Date.now()), { scope: "notes", kind: "journal", title: "InNotes", body: "x", request_id: newId() } as never);
    writeEntry(writeCtxAt(f, Date.now()), { scope: "_me", kind: "journal", title: "InMe", body: "x", request_id: newId() } as never);

    printJournal(f.db, undefined, undefined, undefined);
    expect(lines).toHaveLength(2);
  });

  it("rejects both --day and --since together", () => {
    const f = setup();
    expect(() => printJournal(f.db, "notes", "2026-10-18", "2d")).toThrow(/either --day or --since/);
  });
});

describe("ctxd signals (CLI)", () => {
  it("lists an open blocker signal, materialized automatically by the write path", () => {
    const f = setup();
    const blocker = writeEntry(writeCtxAt(f, Date.now()), {
      scope: "notes",
      kind: "journal",
      title: "Blocked",
      body: "Waiting on the test fixture.",
      significance: "blocker",
      request_id: newId(),
    } as never);
    if ("held" in blocker) throw new Error("unexpected hold");

    // Sanity check (per the task): confirm the signal row exists before asserting on the CLI output.
    const row = f.db.prepare("SELECT source, resolved_hlc FROM signals WHERE entry_id = ?").get(blocker.id) as
      | { source: string; resolved_hlc: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.source).toBe("journal");
    expect(row?.resolved_hlc).toBeNull();

    printSignals(f.db, "notes");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("BLOCKER");
    expect(lines[0]).toContain(blocker.ref);
  });

  it("excludes a signal once it is resolved by a later entry", () => {
    const f = setup();
    const blocker = writeEntry(writeCtxAt(f, Date.now()), {
      scope: "notes",
      kind: "journal",
      title: "Blocked",
      body: "Waiting on the test fixture.",
      significance: "blocker",
      request_id: newId(),
    } as never);
    if ("held" in blocker) throw new Error("unexpected hold");

    writeEntry(writeCtxAt(f, Date.now() + 1000), {
      scope: "notes",
      kind: "journal",
      title: "Fixed",
      body: "Fixture landed.",
      links: [{ type: "resolved", ref: blocker.ref }],
      request_id: newId(),
    } as never);

    const row = f.db.prepare("SELECT resolved_hlc FROM signals WHERE entry_id = ?").get(blocker.id) as { resolved_hlc: string | null };
    expect(row.resolved_hlc).not.toBeNull();

    printSignals(f.db, "notes");
    expect(lines).toEqual(["No open signals."]);
  });

  it("reads across every scope when none is given", () => {
    const f = setup();
    writeEntry(writeCtxAt(f, Date.now()), {
      scope: "notes", kind: "journal", title: "Blocked", body: "x", significance: "incident", request_id: newId(),
    } as never);

    printSignals(f.db, undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("INCIDENT");
  });
});
