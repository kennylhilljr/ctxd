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
import { runSearch } from "../../src/search/fts.js";
import { formatRef } from "../../src/model/refs.js";

/** `runSearch`'s importance flag (SPEC 11.2/11.3, M5, W5.3): list mode (`query: "*"`) lists
 * strictly by time whatever the importance flag says (SPEC 11.2: "results are listed newest
 * first instead of by relevance"); importance only ever reorders scored (non-"*") search. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-search-importance-")), "ctxd.db");
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

function writeCtx(f: Fixture): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId };
}

function requestCtx(f: Fixture, flags?: Map<string, boolean>): RequestContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId, clientName: "human", vendor: "human", assumedPools: [], flags };
}

describe("runSearch's importance ranking (SPEC 11.2/11.3, M5, W5.3): the importance feature flag", () => {
  it("list mode (query '*') lists strictly by time, whether importance is on or off", async () => {
    const f = setup();
    const older = writeEntry(writeCtx(f), { scope: "notes", kind: "note", title: "Older note", body: "x", request_id: newId() } as never);
    const newer = writeEntry(writeCtx(f), { scope: "notes", kind: "note", title: "Newer note", body: "y", request_id: newId() } as never);
    if ("held" in older || "held" in newer) throw new Error("unexpected hold");

    // Give the older entry enough links that importance, if it were consulted, would outweigh
    // the 180-day recency gap and rank it first; list mode must ignore this either way.
    const oldHlc = encodeHlc({ physical: Date.now() - 180 * 86_400_000, counter: 0, node: f.nodeId });
    f.db.prepare("UPDATE entries SET updated_hlc = ? WHERE entry_id = ?").run(oldHlc, older.id);
    const olderRef = formatRef("notes", older.id);
    for (let i = 0; i < 10; i++) {
      f.db
        .prepare("INSERT INTO relations (link_id, entry_id, type, target, added_event) VALUES (?, ?, 'relates_to', ?, ?)")
        .run(newId(), newId(), olderRef, newId());
    }

    for (const flags of [undefined, new Map([["importance", false]])]) {
      const result = await runSearch(requestCtx(f, flags), { scope: "notes", query: "*", limit: 10, max_tokens: 2000, include_proposed: true });
      const refs = result.results.map((r) => r.ref);
      expect(refs.indexOf(newer.ref)).toBeLessThan(refs.indexOf(older.ref));
    }
  });
});
