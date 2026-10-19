import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { encodeHlc, HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import type { RequestContext } from "../../src/server/context.js";
import { assembleBrief } from "../../src/brief/assemble.js";
import { formatRef } from "../../src/model/refs.js";
import { CtxdError } from "../../src/core/errors.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-brief-")), "ctxd.db");
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
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, notesScopeId };
}

function writeCtx(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId };
}

function requestCtx(f: Fixture, clientId: string, clientName: string, flags?: Map<string, boolean>): RequestContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId, clientName, vendor: "human", assumedPools: [], flags };
}

describe("assembleBrief (SPEC v6 section 11.1)", () => {
  it("rejects an unknown scope", () => {
    const f = setup();
    expect(() => assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "nope", size: "normal" })).toThrow(CtxdError);
  });

  it("includes the latest status entry and the pinned brief body, but not in micro size", () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "status", title: "Status", body: "On track.", request_id: newId() } as never);
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "brief", title: "Brief", body: "Pinned overview.", request_id: newId() } as never);

    const normal = assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "normal" }) as { brief: string; scope: string };
    expect(normal.scope).toBe("notes");
    expect(normal.brief).toContain("On track.");
    expect(normal.brief).toContain("Pinned overview.");

    const micro = assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "micro" }) as { brief: string };
    expect(micro.brief).toContain("On track.");
    expect(micro.brief).not.toContain("Pinned overview.");
  });

  it("excludes a superseded decision and shows only its replacement", () => {
    const f = setup();
    const original = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "Old", body: "x", request_id: newId() } as never);
    if ("held" in original) throw new Error("unexpected hold");
    writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "New",
      body: "y",
      supersedes: original.ref,
      request_id: newId(),
    } as never);

    const result = assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "normal" }) as { brief: string };
    expect(result.brief).toContain("New");
    expect(result.brief).not.toContain("Old:");
  });

  it("bumps read_stats.briefed for entries included in the brief", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "status", title: "S", body: "Body.", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");

    assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "normal" });
    const row = f.db.prepare("SELECT briefed FROM read_stats WHERE entry_id = ?").get(created.id) as { briefed: number };
    expect(row.briefed).toBe(1);
  });

  it("surfaces a proposed-count notice without including proposed entries in normal size", () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Proposed decision",
      body: "x",
      request_id: newId(),
    } as never);
    // The human client always writes active (SPEC 10.4); flip it to proposed directly to test this notice in isolation.
    f.db.prepare(`UPDATE entries SET status = 'proposed' WHERE scope_id = ? AND title = 'Proposed decision'`).run(f.notesScopeId);

    const result = assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "normal" }) as { brief: string; notices: string[] };
    expect(result.notices).toEqual(["1 proposed entry awaiting review."]);
    expect(result.brief).not.toContain("Proposed decision");
  });

  it("surfaces an open signal from a blocker journal entry (store/write.ts syncs signals on every write)", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "journal",
      significance: "blocker",
      title: "Blocked on fixture",
      body: "Waiting on the test fixture for sealed pools.",
      request_id: newId(),
    } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const result = assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "normal" }) as { brief: string };
    expect(result.brief).toContain("Open signals:");
    expect(result.brief).toContain("BLOCKER");
    expect(result.brief).toContain(created.ref);
  });
});

describe("assembleBrief's importance ranking (SPEC 11.3, M5): the importance feature flag", () => {
  it("ranks a heavily-linked older convention above a newer unlinked one when importance is on, but by recency alone when it is off", () => {
    const f = setup();
    const older = writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "convention",
      title: "Older convention",
      summary: "Older, heavily linked convention",
      body: "x",
      request_id: newId(),
    } as never);
    const newer = writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "convention",
      title: "Newer convention",
      summary: "Newer, unlinked convention",
      body: "y",
      request_id: newId(),
    } as never);
    if ("held" in older || "held" in newer) throw new Error("unexpected hold");

    // Backdate `older` by 180 days (importance's recency half-life is 90 days), so its recency
    // score alone would lose to `newer`'s; ten inbound links should outweigh that under
    // importance, but recency-only ranking (the flag off) only ever sees the dates.
    const oldHlc = encodeHlc({ physical: Date.now() - 180 * 86_400_000, counter: 0, node: f.nodeId });
    f.db.prepare("UPDATE entries SET updated_hlc = ? WHERE entry_id = ?").run(oldHlc, older.id);
    const olderRef = formatRef("notes", older.id);
    for (let i = 0; i < 10; i++) {
      f.db
        .prepare("INSERT INTO relations (link_id, entry_id, type, target, added_event) VALUES (?, ?, 'relates_to', ?, ?)")
        .run(newId(), newId(), olderRef, newId());
    }

    const withImportance = assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "normal" }) as { brief: string };
    const olderIdx = withImportance.brief.indexOf("Older, heavily linked convention");
    const newerIdx = withImportance.brief.indexOf("Newer, unlinked convention");
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeLessThan(newerIdx); // importance on: links outweigh the 180-day recency gap

    const withoutImportance = assembleBrief(requestCtx(f, f.humanId, "human", new Map([["importance", false]])), {
      scope: "notes",
      size: "normal",
    }) as { brief: string };
    const olderIdxOff = withoutImportance.brief.indexOf("Older, heavily linked convention");
    const newerIdxOff = withoutImportance.brief.indexOf("Newer, unlinked convention");
    expect(newerIdxOff).toBeLessThan(olderIdxOff); // importance off: pure recency, newer sorts first
  });
});
