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
import { contextSearch } from "../../src/tools/search.js";
import { contextGet } from "../../src/tools/get.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-tools-read-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  clock: HlcClock;
  nodeId: string;
  agentId: string;
  agentName: string;
  humanId: string;
  notesScopeId: string;
  privateAScopeId: string;
}

/** A node with: a 'notes' scope the agent's pool can read/write, and a pooled 'private-a' scope it cannot. */
function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());

  const notesScopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(notesScopeId, now());
  const privateAScopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'private-a', ?)").run(privateAScopeId, now());

  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    humanId,
    nodeId,
    newId(),
    now(),
  );

  const agentId = newId();
  const agentName = "codex@laptop";
  db.prepare(
    "INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, ?, 'openai', ?, ?, ?)",
  ).run(agentId, agentName, nodeId, newId(), now());

  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'write')").run(notesScopeId);

  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-private', 'pool-private', ?)").run(now());
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-private', ?, 'write')").run(privateAScopeId);

  return { db, clock: new HlcClock(nodeId), nodeId, agentId, agentName, humanId, notesScopeId, privateAScopeId };
}

function writeCtx(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId };
}

function requestCtx(f: Fixture, clientId: string, clientName: string, vendor: "human" | "openai", assumedPools: string[] = []): RequestContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId, clientName, vendor, assumedPools };
}

describe("contextSearch (SPEC v6 section 11.2)", () => {
  it("finds a matching entry by full-text query, scoped to a readable scope", async () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Use SQLite for local storage",
      body: "We chose SQLite with WAL mode.",
      request_id: newId(),
    } as never);

    const result = (await contextSearch(requestCtx(f, f.humanId, "human", "human"), {
      scope: "notes",
      query: "SQLite",
      limit: 10,
      max_tokens: 4000,
      include_proposed: true,
    })) as { results: { title: string }[] };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe("Use SQLite for local storage");
  });

  it("excludes results from a scope the client has no access to (default deny)", async () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), {
      scope: "private-a",
      kind: "note",
      title: "Secret plan",
      body: "Nobody but pool-private should see this.",
      request_id: newId(),
    } as never);

    const result = (await contextSearch(requestCtx(f, f.agentId, f.agentName, "openai", ["pool-dev"]), {
      scope: "private-a",
      query: "Secret",
      limit: 10,
      max_tokens: 4000,
      include_proposed: true,
    })) as { results: unknown[] };
    expect(result.results).toHaveLength(0);
  });

  it("lists by recency instead of relevance when query is '*'", async () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "First", body: "a", request_id: newId() } as never);
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "Second", body: "b", request_id: newId() } as never);

    const result = (await contextSearch(requestCtx(f, f.humanId, "human", "human"), {
      scope: "notes",
      query: "*",
      limit: 10,
      max_tokens: 4000,
      include_proposed: true,
    })) as { results: { title: string }[] };
    expect(result.results.map((r) => r.title)).toEqual(["Second", "First"]);
  });

  it("excludes a proposed agent decision by default and includes it with include_proposed", async () => {
    const f = setup();
    writeEntry(writeCtx(f, f.agentId), {
      scope: "notes",
      kind: "decision",
      title: "Agent proposed decision",
      body: "Needs review.",
      request_id: newId(),
    } as never);

    const ctx = requestCtx(f, f.agentId, f.agentName, "openai", ["pool-dev"]);
    const excluded = (await contextSearch(ctx, { scope: "notes", query: "proposed", limit: 10, max_tokens: 4000, include_proposed: false })) as {
      results: unknown[];
    };
    expect(excluded.results).toHaveLength(0);

    const included = (await contextSearch(ctx, { scope: "notes", query: "proposed", limit: 10, max_tokens: 4000, include_proposed: true })) as {
      results: unknown[];
    };
    expect(included.results).toHaveLength(1);
  });

  it("restricts results to a path's folder prefix, deriving the scope from the path", async () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "In decisions", body: "SQLite here", request_id: newId() } as never);
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "note", title: "In notes", body: "SQLite there too", request_id: newId() } as never);

    const result = (await contextSearch(requestCtx(f, f.humanId, "human", "human"), {
      path: "ctxd://notes/decisions/",
      query: "SQLite",
      limit: 10,
      max_tokens: 4000,
      include_proposed: true,
    })) as { results: { title: string }[] };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe("In decisions");
  });
});

describe("contextGet (SPEC v6 section 4.2)", () => {
  it("fetches an entry by its ctxd: reference", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "note",
      title: "Fetchable note",
      body: "Body text.",
      request_id: newId(),
    } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const result = contextGet(requestCtx(f, f.humanId, "human", "human"), {
      ids: [created.ref],
      related: false,
      max_tokens: 4000,
    }) as { entries: { title: string; body: string }[] };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("Fetchable note");
    expect(result.entries[0]!.body).toBe("Body text.");
  });

  it("resolves an entry by its ctxd:// path", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Use SQLite",
      body: "Body.",
      request_id: newId(),
    } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const row = f.db.prepare("SELECT slug FROM entries WHERE entry_id = ?").get(created.id) as { slug: string };
    const result = contextGet(requestCtx(f, f.humanId, "human", "human"), {
      ids: [`ctxd://notes/decisions/${row.slug}.md`],
      related: false,
      max_tokens: 4000,
    }) as { entries: { title: string }[] };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("Use SQLite");
  });

  it("resolves nothing for a ref in a scope the client cannot read (regression: must not throw or leak)", () => {
    const f = setup();
    const created = writeEntry(writeCtx(f, f.humanId), {
      scope: "private-a",
      kind: "note",
      title: "Secret",
      body: "Body.",
      request_id: newId(),
    } as never);
    if ("held" in created) throw new Error("unexpected hold");

    const result = contextGet(requestCtx(f, f.agentId, f.agentName, "openai", ["pool-dev"]), {
      ids: [created.ref],
      related: false,
      max_tokens: 4000,
    }) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("returns a kind-folder listing for ctxd://notes/decisions/", () => {
    const f = setup();
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "Decision A", body: "a", request_id: newId() } as never);
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "decision", title: "Decision B", body: "b", request_id: newId() } as never);

    const result = contextGet(requestCtx(f, f.humanId, "human", "human"), {
      ids: ["ctxd://notes/decisions/"],
      related: false,
      max_tokens: 4000,
    }) as { folders: { path: string; children: unknown[] }[] };
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]!.path).toBe("ctxd://notes/decisions/");
    expect(result.folders[0]!.children).toHaveLength(2);
  });

  it("resolves skill:<name> to the active skill entry", () => {
    const f = setup();
    const body = "---\nname: deploy-runbook\ndescription: How to deploy.\n---\nSteps here.";
    writeEntry(writeCtx(f, f.humanId), { scope: "notes", kind: "skill", title: "deploy-runbook", body, request_id: newId() } as never);

    const result = contextGet(requestCtx(f, f.humanId, "human", "human"), {
      ids: ["skill:deploy-runbook"],
      related: false,
      max_tokens: 4000,
    }) as { entries: { kind: string }[] };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.kind).toBe("skill");
  });

  it("follows a supersedes relation as a related entry when related: true", () => {
    const f = setup();
    const original = writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Original",
      body: "Body.",
      request_id: newId(),
    } as never);
    if ("held" in original) throw new Error("unexpected hold");
    const replacement = writeEntry(writeCtx(f, f.humanId), {
      scope: "notes",
      kind: "decision",
      title: "Replacement",
      body: "Body.",
      supersedes: original.ref,
      links: [{ type: "supersedes", ref: original.ref }],
      request_id: newId(),
    } as never);
    if ("held" in replacement) throw new Error("unexpected hold");

    const result = contextGet(requestCtx(f, f.humanId, "human", "human"), {
      ids: [replacement.ref],
      related: true,
      max_tokens: 4000,
    }) as { entries: { related?: { ref: string }[] }[] };
    expect(result.entries[0]!.related).toBeDefined();
    expect(result.entries[0]!.related![0]!.ref).toBe(original.ref);
  });

  it("truncates by dropping entries once max_tokens is exceeded, and sets the hint", () => {
    const f = setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const created = writeEntry(writeCtx(f, f.humanId), {
        scope: "notes",
        kind: "note",
        title: `Note ${i}`,
        body: "x".repeat(500),
        request_id: newId(),
      } as never);
      if ("held" in created) throw new Error("unexpected hold");
      ids.push(created.ref);
    }

    const result = contextGet(requestCtx(f, f.humanId, "human", "human"), { ids, related: false, max_tokens: 100 }) as {
      entries: unknown[];
      truncated: boolean;
      hint?: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThan(5);
    expect(result.hint).toBeDefined();
  });
});
