import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import type { RequestContext } from "../../src/server/context.js";
import { assembleBrief } from "../../src/brief/assemble.js";
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

function requestCtx(f: Fixture, clientId: string, clientName: string): RequestContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId, clientName, vendor: "human", assumedPools: [] };
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

  describe("sync freshness header and stale-sync notice (M3 slice 7)", () => {
    it("reports sync: null and no notice when this node has no peers at all", () => {
      const f = setup();
      const result = assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "normal" }) as { sync: unknown; notices: string[] };
      expect(result.sync).toBeNull();
      expect(result.notices).toEqual([]);
    });

    it("reports sync.stale: false and no notice when a peer synced recently", () => {
      const f = setup();
      f.db
        .prepare(
          "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at, last_synced_at) VALUES (?, 'laptop', 'https://laptop.example/ctxd-sync', 'home', ?, ?, ?)",
        )
        .run(newId(), newId(), now(), now());

      const result = assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "normal" }) as {
        sync: { last_synced_at: string; stale: boolean } | null;
        notices: string[];
      };
      expect(result.sync?.stale).toBe(false);
      expect(result.notices).toEqual([]);
    });

    it("reports sync.stale: true and a stale-sync notice when no peer has synced in over 10 minutes", () => {
      const f = setup();
      const staleSync = new Date(Date.now() - 11 * 60_000).toISOString();
      f.db
        .prepare(
          "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at, last_synced_at) VALUES (?, 'laptop', 'https://laptop.example/ctxd-sync', 'home', ?, ?, ?)",
        )
        .run(newId(), newId(), now(), staleSync);

      const result = assembleBrief(requestCtx(f, f.humanId, "human"), { scope: "notes", size: "normal" }) as {
        sync: { last_synced_at: string; stale: boolean } | null;
        notices: string[];
      };
      expect(result.sync?.stale).toBe(true);
      expect(result.notices).toContain("No successful sync in over 10 minutes; this brief may be missing recent changes from other machines.");
    });
  });
});
