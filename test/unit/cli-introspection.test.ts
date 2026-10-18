import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { printBrief } from "../../src/cli/brief.js";
import { printHistory } from "../../src/cli/history.js";
import { printShow } from "../../src/cli/show.js";
import { printStats } from "../../src/cli/stats.js";
import { printLs } from "../../src/cli/ls.js";
import { printTree } from "../../src/cli/tree.js";
import { printRead } from "../../src/cli/read.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-cli-")), "ctxd.db");
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

function writeCtx(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId };
}

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ctxd brief (CLI)", () => {
  it("prints the scope header and the brief body", () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "status", title: "S", body: "On track.", request_id: newId() } as never);
    printBrief(f.db, "notes", "normal");
    expect(lines.join("\n")).toContain("Scope: notes");
    expect(lines.join("\n")).toContain("On track.");
  });
});

describe("ctxd history (CLI)", () => {
  it("prints one line per event, oldest first", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "v1", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "v2", id: created.id, expected_rev: created.rev, request_id: newId() } as never);

    printHistory(f.db, created.ref);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("create");
    expect(lines[1]).toContain("update");
  });
});

describe("ctxd show (CLI)", () => {
  it("shows the current entry without --as-of", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Original", body: "v1", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Updated", id: created.id, expected_rev: created.rev, request_id: newId() } as never);

    printShow(f.db, created.ref);
    expect(lines.join("\n")).toContain("title: Updated");
  });

  it("reconstructs the entry's state as of a time before the update", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Original", body: "v1", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    const updated = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Updated", id: created.id, expected_rev: created.rev, request_id: newId() } as never);
    if ("held" in updated) throw new Error("unexpected hold");
    // Both writes can land in the same millisecond in a fast test run; push the update's
    // received_at safely into the future so "between" reliably separates the two.
    f.db.prepare("UPDATE events SET received_at = ? WHERE op = 'update' AND entry_id = ?").run(new Date(Date.now() + 3600_000).toISOString(), created.id);
    const between = new Date(Date.now() + 1800_000).toISOString();

    printShow(f.db, created.ref, between);
    expect(lines.join("\n")).toContain("title: Original");
    expect(lines.join("\n")).not.toContain("title: Updated");
  });

  it("reports NOT_FOUND for a time before the entry existed", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "v1", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    expect(() => printShow(f.db, created.ref, "2000-01-01")).toThrow(/did not exist/);
  });
});

describe("ctxd stats (CLI)", () => {
  it("prints nothing recorded when tool_metrics is empty", () => {
    const f = setup();
    printStats(f.db);
    expect(lines.join("\n")).toContain("No tool calls recorded yet.");
  });

  it("aggregates recorded tool_metrics rows by tool and client", () => {
    const f = setup();
    f.db
      .prepare("INSERT INTO tool_metrics (at, client_id, tool, scope_id, chars, est_tokens, truncated) VALUES (?, ?, 'context_search', NULL, 100, 25, 0)")
      .run(now(), f.humanId);
    f.db
      .prepare("INSERT INTO tool_metrics (at, client_id, tool, scope_id, chars, est_tokens, truncated) VALUES (?, ?, 'context_search', NULL, 200, 50, 1)")
      .run(now(), f.humanId);

    printStats(f.db);
    const row = lines.find((l) => l.includes("context_search"));
    expect(row).toContain("human");
    expect(row).toMatch(/2\s/);
  });
});

describe("ctxd ls/tree/read (CLI, reusing context_get)", () => {
  it("ls lists a kind-folder's entries", () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "D", body: "Chose option A.", request_id: newId() } as never);
    printLs(f.db, "ctxd://notes/decisions/");
    expect(lines[0]).toContain("ctxd://notes/decisions/");
    expect(lines.some((l) => l.includes("Chose option A."))).toBe(true);
  });

  it("read prints an entry's full body by ctxd: reference", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "Full body text.", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    printRead(f.db, created.ref);
    expect(lines.join("\n")).toContain("Full body text.");
  });

  it("read prints a folder overview given a valid path", () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "D", body: "x", request_id: newId() } as never);
    printRead(f.db, "ctxd://notes/decisions/");
    expect(lines[0]).toContain("ctxd://notes/decisions/");
  });

  it("tree walks the root into scopes without crashing", () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "D", body: "x", request_id: newId() } as never);
    printTree(f.db, "ctxd://", 2);
    expect(lines.join("\n")).toContain("notes");
  });

  it("still prints a child folder's line even when contextGet can't resolve it yet (regression: journal/ silently vanishing)", () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "journal", significance: "routine", title: "J", body: "x", request_id: newId() } as never);
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "D", body: "x", request_id: newId() } as never);
    printTree(f.db, "ctxd://notes/", 2);
    expect(lines.some((l) => l.includes("ctxd://notes/journal/"))).toBe(true);
    expect(lines.some((l) => l.includes("ctxd://notes/decisions/"))).toBe(true);
  });
});
