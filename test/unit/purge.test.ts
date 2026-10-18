import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { flagEntry, unflagEntry } from "../../src/store/flag.js";
import { previewPurge, purgeEntry } from "../../src/store/purge.js";
import { rebuild } from "../../src/store/rebuild.js";
import { CtxdError } from "../../src/core/errors.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-purge-")), "ctxd.db");
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
  const agentId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'codex@laptop', 'openai', ?, ?, ?)").run(
    agentId,
    nodeId,
    newId(),
    now(),
  );
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, agentId };
}

function writeCtx(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId };
}

describe("purgeEntry (SPEC v6 section 7.6.6)", () => {
  it("erases title, summary, body and tags, setting purged_at and a fingerprint", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "note",
      title: "Secret",
      body: "The password is hunter2.",
      tags: ["secret"],
      request_id: newId(),
    } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const result = purgeEntry(writeCtx(f, f.humanId), created.ref, "Leaked a credential.");
    expect(result.ref).toBe(created.ref);

    const row = f.db.prepare("SELECT title, summary, body, tags, purged_at, purge_fingerprint FROM entries WHERE entry_id = ?").get(created.id) as {
      title: string;
      summary: string;
      body: string;
      tags: string;
      purged_at: string | null;
      purge_fingerprint: string | null;
    };
    expect(row.title).toBe("[purged]");
    expect(row.summary).toBe("");
    expect(row.body).toBe("");
    expect(row.tags).toBe("[]");
    expect(row.purged_at).not.toBeNull();
    expect(row.purge_fingerprint).not.toBeNull();
  });

  it("deletes the entry's FTS row so it never surfaces in search", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Findable", body: "uniquemarkerxyz", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const before = f.db.prepare("SELECT COUNT(*) AS n FROM entries_fts WHERE entries_fts MATCH 'uniquemarkerxyz'").get() as { n: number };
    expect(before.n).toBe(1);

    purgeEntry(writeCtx(f, f.humanId), created.ref, "x");

    const after = f.db.prepare("SELECT COUNT(*) AS n FROM entries_fts WHERE entries_fts MATCH 'uniquemarkerxyz'").get() as { n: number };
    expect(after.n).toBe(0);
  });

  it("removes the entry's outbound relations and marks inbound ones [purged]", () => {
    const f = setup();
    const target = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Target", body: "x", request_id: newId() } as never);
    if ("held" in target) throw new Error("unexpected hold");
    const source = writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "note",
      title: "Source",
      body: "x",
      links: [{ type: "points_to", ref: target.ref }],
      request_id: newId(),
    } as never);
    if ("held" in source) throw new Error("unexpected hold");

    purgeEntry(writeCtx(f, f.humanId), target.ref, "x");

    const relation = f.db.prepare("SELECT target FROM relations WHERE entry_id = ?").get(source.id) as { target: string };
    expect(relation.target).toBe("[purged]");
  });

  it("closes any open flags with resolution 'purge'", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    flagEntry(writeCtx(f, f.humanId), { ref: created.ref, problem: "unsafe", reason: "x", request_id: newId() });

    purgeEntry(writeCtx(f, f.humanId), created.ref, "x");

    const row = f.db.prepare("SELECT resolved FROM flags WHERE entry_id = ?").get(created.id) as { resolved: string | null };
    expect(row.resolved).toBe("purge");
  });

  it("rewrites every other stored event for the entry to {purged: true}, but not the purge event itself", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");

    purgeEntry(writeCtx(f, f.humanId), created.ref, "x");

    const rows = f.db.prepare("SELECT op, payload FROM events WHERE entry_id = ? ORDER BY hlc").all(created.id) as { op: string; payload: string }[];
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ purged: true });
    expect(rows[1]!.op).toBe("purge");
    expect(JSON.parse(rows[1]!.payload).purged).toBeUndefined();
  });

  it("blocks reinserting the same title and body after a purge", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Reinsert me", body: "Same content.", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    purgeEntry(writeCtx(f, f.humanId), created.ref, "x");

    try {
      writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Reinsert me", body: "Same content.", request_id: newId() } as never);
      expect.fail("expected VALIDATION");
    } catch (err) {
      expect((err as CtxdError).code).toBe("VALIDATION");
    }
  });

  it("rejects purge from a non-human client", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    expect(() => purgeEntry(writeCtx(f, f.agentId), created.ref, "x")).toThrow(CtxdError);
  });

  it("previews the entry to be purged without writing anything", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Preview me", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const preview = previewPurge(f.db, created.ref);
    expect(preview).toEqual({ ref: created.ref, kind: "note", title: "Preview me", scope: "notes" });
    const row = f.db.prepare("SELECT purged_at FROM entries WHERE entry_id = ?").get(created.id) as { purged_at: string | null };
    expect(row.purged_at).toBeNull();
  });

  it("does not crash a rebuild after a purge (known M1 gap: the entry ends up absent, not a placeholder)", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    purgeEntry(writeCtx(f, f.humanId), created.ref, "x");

    expect(() => rebuild(f.db)).not.toThrow();
    const row = f.db.prepare("SELECT 1 FROM entries WHERE entry_id = ?").get(created.id);
    expect(row).toBeUndefined();
  });
});

function dumpHash(db: Database.Database): string {
  const rows = (table: string, order: string) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all());
  const dump = [rows("entries", "entry_id"), rows("relations", "link_id"), rows("flags", "flag_id")].join("\u0000");
  return createHash("sha256").update(dump).digest("hex");
}

describe("ctxd rebuild replays unflag deterministically (AGENTS.md: sync/apply changes need convergence tests)", () => {
  it("reproduces identical state across a flag/unflag/edit sequence", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "x", request_id: newId() } as never);
    if ("held" in created) throw new Error("unexpected hold");
    flagEntry(writeCtx(f, f.humanId), { ref: created.ref, problem: "stale", reason: "a", request_id: newId() });
    unflagEntry(writeCtx(f, f.humanId), created.ref);
    flagEntry(writeCtx(f, f.humanId), { ref: created.ref, problem: "wrong", reason: "b", request_id: newId() });
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "N", body: "y", id: created.id, expected_rev: created.rev, request_id: newId() } as never);

    const before = dumpHash(f.db);
    rebuild(f.db);
    const after = dumpHash(f.db);
    expect(after).toBe(before);
  });
});
