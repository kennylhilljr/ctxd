import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { makeRev, newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { purgeEntry } from "../../src/store/purge.js";
import { applyEvent, type WireEvent } from "../../src/sync/apply.js";

/** Tests for Spec v8 7.6.6's purge propagation: always-fast-forward purge events, and step 3's strip-on-receipt for a late arrival. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-sync-purge-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
  humanId: string;
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
  return { db, nodeId, humanId, scopeId };
}

function wctx(f: Fixture): WriteContext {
  return { db: f.db, clock: new HlcClock(f.nodeId), nodeId: f.nodeId, clientId: f.humanId };
}

/** A synthetic content "update" WireEvent, as if it arrived late from an offline peer. */
function lateUpdate(f: Fixture, entryId: string, parentRev: string): WireEvent {
  const eventId = newId();
  return {
    eventId,
    originNode: newId(),
    originSeq: 1,
    hlc: `${Date.now().toString(16).padStart(13, "0")}-0001-${f.nodeId}`,
    scopeId: f.scopeId,
    entryId,
    op: "update",
    part: "content",
    parentRevs: [parentRev],
    rev: makeRev(2, eventId),
    clientId: f.humanId,
    sessionRef: null,
    requestId: null,
    requestHash: null,
    payload: { body: "a late edit from before the purge propagated" },
    prev: null,
  };
}

/** A synthetic purge (meta) WireEvent, as if received from a peer that already purged this entry. */
function purgeWireEvent(f: Fixture, entryId: string, kind: string, slug: string): WireEvent {
  return purgeWireEventAt(f, entryId, kind, slug, `${Date.now().toString(16).padStart(13, "0")}-0002-${f.nodeId}`, "deadbeef");
}

/** Same as `purgeWireEvent`, with an explicit hlc/fingerprint: for exercising two independent purges of the same entry (Spec 7.3's convergence property) rather than a wire-level replay of one event. */
function purgeWireEventAt(f: Fixture, entryId: string, kind: string, slug: string, hlc: string, fingerprint: string): WireEvent {
  const eventId = newId();
  return {
    eventId,
    originNode: newId(),
    originSeq: 1,
    hlc,
    scopeId: f.scopeId,
    entryId,
    op: "purge",
    part: "meta",
    parentRevs: [],
    rev: makeRev(1, eventId),
    clientId: f.humanId,
    sessionRef: null,
    requestId: null,
    requestHash: null,
    payload: { fingerprint, reason: "test", scope_id: f.scopeId, kind, slug },
    prev: null,
  };
}

describe("a purge event received via sync always fast-forwards (Spec 7.6.6)", () => {
  it("reconstructs the stub row even with no prior create materialized locally", () => {
    const f = setup();
    const event = purgeWireEvent(f, newId(), "fact", "never-created-here");

    const result = applyEvent(f.db, event);
    expect(result.outcome).toBe("fast-forward");

    const row = f.db.prepare("SELECT title, body, status, purged_at FROM entries WHERE entry_id = ?").get(event.entryId) as {
      title: string;
      body: string;
      status: string;
      purged_at: string | null;
    };
    expect(row.title).toBe("[purged]");
    expect(row.body).toBe("");
    expect(row.purged_at).not.toBeNull();
  });

  it("is idempotent: the same purge event applied twice is already-known the second time", () => {
    const f = setup();
    const event = purgeWireEvent(f, newId(), "fact", "dup");
    expect(applyEvent(f.db, event).outcome).toBe("fast-forward");
    expect(applyEvent(f.db, event).outcome).toBe("already-known");
  });
});

describe("step 3: a late arrival for an already-purged entry is stripped on receipt", () => {
  it("stores the event with payload {purged:true}, not its real content, and never un-erases the entry", () => {
    const f = setup();
    const created = writeEntry(wctx(f), { scope: "notes", kind: "fact", title: "F", body: "real content", request_id: newId() } as never) as {
      id: string;
      ref: string;
      rev: string;
    };
    purgeEntry(wctx(f), created.ref, "testing purge propagation");
    expect((f.db.prepare("SELECT purged_at FROM entries WHERE entry_id = ?").get(created.id) as { purged_at: string | null }).purged_at).not.toBeNull();

    const late = lateUpdate(f, created.id, created.rev);
    const result = applyEvent(f.db, late);
    expect(result.outcome).toBe("purge-stripped");

    const storedEvent = f.db.prepare("SELECT payload, prev FROM events WHERE event_id = ?").get(late.eventId) as { payload: string; prev: string | null };
    expect(JSON.parse(storedEvent.payload)).toEqual({ purged: true });
    expect(storedEvent.prev).toBeNull();

    const entry = f.db.prepare("SELECT title, body FROM entries WHERE entry_id = ?").get(created.id) as { title: string; body: string };
    expect(entry.title).toBe("[purged]");
    expect(entry.body).toBe("");
  });

});

// Two nodes can each independently purge the same entry while partitioned (their own, possibly
// differently-fingerprinted, unsynced content): a genuinely concurrent pair of purge events, not
// a wire-level replay of one. decide() lets every purge event through rather than stripping the
// second one outright, so materialize.ts's own HLC guard — not which one a given node happens to
// receive first — decides the outcome (Spec 7.3's convergence property).
describe("two independent purges of the same entry converge by HLC, not arrival order (Spec 7.3, 7.6.6)", () => {
  it("a second purge event with an earlier HLC than the one already applied is a no-op for the row", () => {
    const f = setup();
    const created = writeEntry(wctx(f), { scope: "notes", kind: "note", title: "N", body: "b", request_id: newId() } as never) as { id: string; ref: string };
    const later = purgeWireEventAt(f, created.id, "note", "n", "0000002000000-0001-later", "later-fingerprint");
    const earlier = purgeWireEventAt(f, created.id, "note", "n", "0000001000000-0001-earlier", "earlier-fingerprint");

    expect(applyEvent(f.db, later).outcome).toBe("fast-forward");
    expect(applyEvent(f.db, earlier).outcome).toBe("fast-forward"); // let through by decide(), but a no-op in materialize.ts

    const row = f.db.prepare("SELECT purge_fingerprint FROM entries WHERE entry_id = ?").get(created.id) as { purge_fingerprint: string };
    expect(row.purge_fingerprint).toBe("later-fingerprint"); // the earlier purge never overwrote it

    // the earlier purge event's own payload is untouched (not stripped to {"purged": true}):
    // it is a losing concurrent purge, not a late arrival for an already-settled entry (step 3).
    const storedEvent = f.db.prepare("SELECT payload FROM events WHERE event_id = ?").get(earlier.eventId) as { payload: string };
    expect(JSON.parse(storedEvent.payload)).toMatchObject({ fingerprint: "earlier-fingerprint" });
  });

  it("a second purge event with a later HLC overwrites the row's fingerprint", () => {
    const f = setup();
    const created = writeEntry(wctx(f), { scope: "notes", kind: "note", title: "N", body: "b", request_id: newId() } as never) as { id: string; ref: string };
    const earlier = purgeWireEventAt(f, created.id, "note", "n", "0000001000000-0001-earlier", "earlier-fingerprint");
    const later = purgeWireEventAt(f, created.id, "note", "n", "0000002000000-0001-later", "later-fingerprint");

    expect(applyEvent(f.db, earlier).outcome).toBe("fast-forward");
    expect(applyEvent(f.db, later).outcome).toBe("fast-forward");

    const row = f.db.prepare("SELECT purge_fingerprint FROM entries WHERE entry_id = ?").get(created.id) as { purge_fingerprint: string };
    expect(row.purge_fingerprint).toBe("later-fingerprint");
  });

  it("converges to the same fingerprint regardless of which concurrent purge event is applied first", () => {
    function run(order: "a-then-b" | "b-then-a"): string {
      const f = setup();
      const created = writeEntry(wctx(f), { scope: "notes", kind: "note", title: "N", body: "b", request_id: newId() } as never) as { id: string; ref: string };
      const a = purgeWireEventAt(f, created.id, "note", "n", "0000001000000-0001-a", "fingerprint-a");
      const b = purgeWireEventAt(f, created.id, "note", "n", "0000002000000-0001-b", "fingerprint-b");
      if (order === "a-then-b") {
        applyEvent(f.db, a);
        applyEvent(f.db, b);
      } else {
        applyEvent(f.db, b);
        applyEvent(f.db, a);
      }
      return (f.db.prepare("SELECT purge_fingerprint FROM entries WHERE entry_id = ?").get(created.id) as { purge_fingerprint: string }).purge_fingerprint;
    }

    const forward = run("a-then-b");
    const backward = run("b-then-a");
    expect(forward).toBe(backward);
    expect(forward).toBe("fingerprint-b"); // later HLC wins either way
  });
});
