import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { purgeEntry } from "../../src/store/purge.js";
import { servePull, recordServedThrough } from "../../src/sync/pull.js";
import { countUnsynced, peerSyncAges } from "../../src/sync/freshness.js";

/**
 * W3: the served-side watermark (`peer_watermarks`) and the observability it unlocks
 * (`ctxd doctor`'s per-peer last sync age, `ctxd status`'s real unsynced count), after
 * partitions, restarts and purge.
 */

function freshDb(path?: string): Database.Database {
  const dbPath = path ?? join(mkdtempSync(join(tmpdir(), "ctxd-sync-obs-")), "ctxd.db");
  return openDatabase(dbPath, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  path: string;
  clock: HlcClock;
  nodeId: string;
  humanId: string;
  scopeId: string;
  peerId: string;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ctxd-sync-obs-"));
  const path = join(dir, "ctxd.db");
  const db = freshDb(path);
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(scopeId, now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    humanId,
    nodeId,
    newId(),
    now(),
  );
  const peerId = newId();
  db.prepare(
    "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at) VALUES (?, 'laptop', 'https://laptop.example/sync', 'home', 'h', ?)",
  ).run(peerId, now());
  return { db, path, clock: new HlcClock(nodeId), nodeId, humanId, scopeId, peerId };
}

function wctx(f: Fixture): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId };
}

/** Simulates one POST /v1/pull from `f.peerId`, exactly what src/server/sync.ts does: serve, then record the watermark. */
function serveOnePull(f: Fixture, vector: Record<string, number>): ReturnType<typeof servePull> {
  const response = servePull(f.db, "home", { node: "requester", vector, limit: 500 });
  recordServedThrough(f.db, f.peerId, response.through);
  return response;
}

describe("recordServedThrough and countUnsynced (W3)", () => {
  it("starts fully unsynced before any pull, and reaches zero once a pull serves everything", () => {
    const f = setup();
    writeEntry(wctx(f), { scope: "notes", kind: "note", title: "A", body: "x", request_id: newId() } as never);
    writeEntry(wctx(f), { scope: "notes", kind: "note", title: "B", body: "y", request_id: newId() } as never);

    expect(countUnsynced(f.db)).toBeGreaterThan(0);
    serveOnePull(f, {});
    expect(countUnsynced(f.db)).toBe(0);
  });

  it("grows again after a partition: the peer stops pulling while this node keeps writing", () => {
    const f = setup();
    writeEntry(wctx(f), { scope: "notes", kind: "note", title: "A", body: "x", request_id: newId() } as never);
    serveOnePull(f, {});
    expect(countUnsynced(f.db)).toBe(0);

    // The peer is partitioned: no more pulls arrive while this node writes more.
    writeEntry(wctx(f), { scope: "notes", kind: "note", title: "B", body: "y", request_id: newId() } as never);
    writeEntry(wctx(f), { scope: "notes", kind: "note", title: "C", body: "z", request_id: newId() } as never);
    expect(countUnsynced(f.db)).toBeGreaterThan(0);

    // The partition heals: the peer pulls again and catches all the way up.
    const vector = Object.fromEntries(
      (f.db.prepare("SELECT peer_id, origin_node, through_seq FROM peer_watermarks WHERE peer_id = ?").all(f.peerId) as { origin_node: string; through_seq: number }[]).map((r) => [
        r.origin_node,
        r.through_seq,
      ]),
    );
    serveOnePull(f, vector);
    expect(countUnsynced(f.db)).toBe(0);
  });

  it("takes the max against an existing watermark, never regressing it", () => {
    const f = setup();
    writeEntry(wctx(f), { scope: "notes", kind: "note", title: "A", body: "x", request_id: newId() } as never);
    serveOnePull(f, {});
    const row = f.db.prepare("SELECT through_seq FROM peer_watermarks WHERE peer_id = ?").get(f.peerId) as { through_seq: number };

    // A stale/duplicate call reporting a lower through value (e.g. a retried page) must not regress it.
    recordServedThrough(f.db, f.peerId, { [f.nodeId]: 0 });
    const after = f.db.prepare("SELECT through_seq FROM peer_watermarks WHERE peer_id = ?").get(f.peerId) as { through_seq: number };
    expect(after.through_seq).toBe(row.through_seq);
  });

  it("survives a restart: the watermark is durable, not in-memory", () => {
    const f = setup();
    writeEntry(wctx(f), { scope: "notes", kind: "note", title: "A", body: "x", request_id: newId() } as never);
    serveOnePull(f, {});
    f.db.close();

    const reopened = freshDb(f.path);
    const unsynced = countUnsynced(reopened);
    expect(unsynced).toBe(0);
    reopened.close();
  });

  it("is unaffected by purging the served entry: the event row and its origin_seq survive purge", () => {
    const f = setup();
    const written = writeEntry(wctx(f), { scope: "notes", kind: "note", title: "A", body: "x", request_id: newId() } as never) as { ref: string };
    serveOnePull(f, {});
    expect(countUnsynced(f.db)).toBe(0);

    purgeEntry(wctx(f), written.ref, "test purge");
    expect(countUnsynced(f.db)).toBeGreaterThan(0); // the purge event is itself a new, not-yet-served event
    serveOnePull(f, {});
    expect(countUnsynced(f.db)).toBe(0);
  });

  it("reports zero with no active peers", () => {
    const f = setup();
    writeEntry(wctx(f), { scope: "notes", kind: "note", title: "A", body: "x", request_id: newId() } as never);
    f.db.prepare("UPDATE peers SET revoked_at = ?").run(now());
    expect(countUnsynced(f.db)).toBe(0);
  });
});

describe("peerSyncAges (W3)", () => {
  it("reports a peer that has never synced using created_at, not stale when just added", () => {
    const f = setup();
    const ages = peerSyncAges(f.db, 24);
    expect(ages).toHaveLength(1);
    expect(ages[0]!.lastSyncedAt).toBeNull();
    expect(ages[0]!.ageHours).toBeLessThan(1);
    expect(ages[0]!.stale).toBe(false);
  });

  it("warns past the threshold for a peer that has never synced and was added long ago", () => {
    const f = setup();
    const longAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();
    f.db.prepare("UPDATE peers SET created_at = ? WHERE peer_id = ?").run(longAgo, f.peerId);
    const ages = peerSyncAges(f.db, 24);
    expect(ages[0]!.stale).toBe(true);
  });

  it("excludes a revoked peer", () => {
    const f = setup();
    f.db.prepare("UPDATE peers SET revoked_at = ? WHERE peer_id = ?").run(now(), f.peerId);
    expect(peerSyncAges(f.db, 24)).toEqual([]);
  });
});
