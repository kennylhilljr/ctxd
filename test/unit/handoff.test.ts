import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import type { RequestContext } from "../../src/server/context.js";
import { contextHandoff } from "../../src/tools/handoff.js";
import { CtxdError } from "../../src/core/errors.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-handoff-")), "ctxd.db");
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
  agentName: string;
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
  const agentName = "codex@laptop";
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, ?, 'openai', ?, ?, ?)").run(
    agentId,
    agentName,
    nodeId,
    newId(),
    now(),
  );
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentId}`);
  const notesScopeId = (db.prepare("SELECT scope_id FROM scopes WHERE name = 'notes'").get() as { scope_id: string }).scope_id;
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'write')").run(notesScopeId);
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, agentId, agentName };
}

function ctx(f: Fixture, clientId: string, clientName: string, vendor: "human" | "openai", assumedPools: string[] = []): RequestContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId, clientName, vendor, assumedPools };
}

describe("contextHandoff (SPEC v6 sections 4.2, 8.2)", () => {
  it("writes a handoff composed from done/next/open_questions", () => {
    const f = setup();
    const result = contextHandoff(ctx(f, f.humanId, "human", "human"), {
      scope: "notes",
      action: "write",
      done: "Shipped slice 5.",
      next: "Start slice 6.",
      request_id: newId(),
    }) as { id: string; status: string };
    expect(result.status).toBe("active");
    const row = f.db.prepare("SELECT kind, body FROM entries WHERE entry_id = ?").get(result.id) as { kind: string; body: string };
    expect(row.kind).toBe("handoff");
    expect(row.body).toContain("Done: Shipped slice 5.");
    expect(row.body).toContain("Next: Start slice 6.");
  });

  it("rejects a write with none of done/next/open_questions", () => {
    const f = setup();
    expect(() => contextHandoff(ctx(f, f.humanId, "human", "human"), { scope: "notes", action: "write", request_id: newId() })).toThrow(
      CtxdError,
    );
  });

  it("requires request_id for write", () => {
    const f = setup();
    expect(() => contextHandoff(ctx(f, f.humanId, "human", "human"), { scope: "notes", action: "write", done: "x" })).toThrow(CtxdError);
  });

  it("returns the latest handoff per client, newest first", () => {
    const f = setup();
    contextHandoff(ctx(f, f.humanId, "human", "human"), { scope: "notes", action: "write", done: "Human did A.", request_id: newId() });
    contextHandoff(ctx(f, f.agentId, f.agentName, "openai", ["pool-dev"]), {
      scope: "notes",
      action: "write",
      done: "Agent did B.",
      request_id: newId(),
    });
    contextHandoff(ctx(f, f.humanId, "human", "human"), { scope: "notes", action: "write", done: "Human did C.", request_id: newId() });

    const result = contextHandoff(ctx(f, f.humanId, "human", "human"), { scope: "notes", action: "latest" }) as {
      handoffs: { by: string; body: string }[];
    };
    expect(result.handoffs).toHaveLength(2);
    const byClient = new Map(result.handoffs.map((h) => [h.by, h.body]));
    expect(byClient.get("human")).toContain("Human did C.");
    expect(byClient.get(f.agentName)).toContain("Agent did B.");
  });

  it("denies latest for a scope the client cannot read", () => {
    const f = setup();
    f.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'private-a', ?)").run(newId(), now());
    expect(() => contextHandoff(ctx(f, f.agentId, f.agentName, "openai", ["pool-dev"]), { scope: "private-a", action: "latest" })).toThrow(
      CtxdError,
    );
  });
});
