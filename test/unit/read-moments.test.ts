import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { sessionStartBrief, subagentStartBrief } from "../../src/hooks/readMoments.js";
import "../../src/hooks/handlers.js"; // registers HOOK_HANDLERS["session-start"]/["subagent-start"] for the dispatchWithDb tests below
import { dispatchWithDb, type HookContext } from "../../src/cli/hook.js";
import { CLAUDE_CODE_ADAPTER } from "../../src/hooks/adapters.js";

/** Tests for read moments R1 to R5 (PRD-hooks-v5 7.2): the session-start and subagent-start briefs. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-read-moments-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
  clientId: string;
  scopeId: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(scopeId, now());
  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'claude-code', 'anthropic', ?, ?, ?)").run(
    clientId,
    nodeId,
    newId(),
    now(),
  );
  // Access is default deny (AGENTS.md): a non-human, non-local client needs an explicit grant to
  // read or write a "project"-kind scope like "notes". This fixture uses a `client_grants`
  // temporary grant (what `ctxd grant` writes), which is checked unconditionally regardless of
  // assumed pools; the pool-grant path (what `ctxd pool grant` plus `ctxd persona issue` writes)
  // is covered separately below, since it depends on resolveAssumedPools reading a real persona
  // token rather than just an access grant.
  db.prepare("INSERT INTO client_grants (client_id, scope_id, level, expires_at, granted_by) VALUES (?, ?, 'write', ?, 'human')").run(
    clientId,
    scopeId,
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  return { db, nodeId, clientId, scopeId };
}

function writeCtxOf(f: Fixture): WriteContext {
  return { db: f.db, clock: new HlcClock(f.nodeId), nodeId: f.nodeId, clientId: f.clientId };
}

function writeStatus(f: Fixture, body: string): void {
  writeEntry(writeCtxOf(f), { scope: "notes", kind: "status", title: "Status", body, request_id: newId() } as never);
}

function baseCtx(f: Fixture, overrides: Partial<HookContext>): HookContext {
  return {
    db: f.db,
    nodeId: f.nodeId,
    clientId: f.clientId,
    clientName: "claude-code",
    adapter: CLAUDE_CODE_ADAPTER,
    event: "session-start",
    sessionRef: "claude-code:s1",
    scope: null,
    scopeNotice: null,
    input: {},
    dataDir: "",
    config: undefined,
    ...overrides,
  };
}

describe("sessionStartBrief (R1 to R4)", () => {
  it("returns the scope notice, not the unavailable fallback, when no scope is bound", () => {
    const f = setup();
    const ctx = baseCtx(f, { scopeNotice: "This directory is not bound to a ctxd scope and has no git remote to bind." });
    expect(sessionStartBrief(ctx)).toEqual({ text: "This directory is not bound to a ctxd scope and has no git remote to bind." });
  });

  it("returns undefined (no output) when there is no scope and no notice", () => {
    const f = setup();
    expect(sessionStartBrief(baseCtx(f, {}))).toBeUndefined();
  });

  it("builds a normal-size brief for a bound scope on startup, containing real content", () => {
    const f = setup();
    writeStatus(f, "On track.");

    const ctx = baseCtx(f, { scope: "notes", input: { source: "startup" } });
    const result = sessionStartBrief(ctx);
    expect(result?.text).toContain("On track.");
  });

  it("builds a micro-size brief for resume, omitting a normal-only section", () => {
    const f = setup();
    writeEntry(writeCtxOf(f), { scope: "notes", kind: "convention", title: "Convention", body: "Always do X.", request_id: newId() } as never);

    const ctx = baseCtx(f, { scope: "notes", input: { source: "resume" } });
    const result = sessionStartBrief(ctx);
    // "Active conventions:" is a normal-only section (assembleBrief guards it with `if (!micro)`).
    expect(result?.text).not.toContain("Active conventions:");
  });

  it("falls back to the spec-literal unavailable notice if assembling the brief throws", () => {
    const f = setup();
    const ctx = baseCtx(f, { scope: "no-such-scope", input: { source: "startup" } });
    expect(sessionStartBrief(ctx)).toEqual({ text: "ctxd unavailable; proceeding without shared context." });
  });
});

describe("subagentStartBrief (R5)", () => {
  it("skips silently (no output) when there is no bound scope", () => {
    const f = setup();
    expect(subagentStartBrief(baseCtx(f, {}))).toBeUndefined();
  });

  it("skips silently, not with the R1 unavailable notice, if assembling the brief throws", () => {
    const f = setup();
    expect(subagentStartBrief(baseCtx(f, { scope: "no-such-scope" }))).toBeUndefined();
  });

  it("returns a micro brief for a bound scope", () => {
    const f = setup();
    writeStatus(f, "On track.");

    const result = subagentStartBrief(baseCtx(f, { scope: "notes" }));
    expect(result?.text).toContain("On track.");
  });
});

describe("wired end to end via dispatchWithDb", () => {
  it("session-start resolves scope through scope_map and returns a real brief", async () => {
    const f = setup();
    writeStatus(f, "On track.");

    const result = await dispatchWithDb(
      f.db,
      "session-start",
      CLAUDE_CODE_ADAPTER,
      "claude-code",
      undefined,
      "/scratch/sample-app",
      { session_id: "s1", cwd: "/scratch/sample-app", source: "startup" },
      { "/scratch/sample-app": "notes" },
      "/scratch/ctxd-data",
      undefined,
    );

    expect(result?.text).toContain("On track.");
  });

  it("subagent-start resolves scope the same way and returns a micro brief", async () => {
    const f = setup();
    writeStatus(f, "On track.");

    const result = await dispatchWithDb(
      f.db,
      "subagent-start",
      CLAUDE_CODE_ADAPTER,
      "claude-code",
      undefined,
      "/scratch/sample-app",
      { session_id: "s2", cwd: "/scratch/sample-app" },
      { "/scratch/sample-app": "notes" },
      "/scratch/ctxd-data",
      undefined,
    );

    expect(result?.text).toContain("On track.");
  });
});

describe("regression: a pool-granted scope is reachable via the client's issued persona token", () => {
  it("resolves assumedPools from persona_tokens, not an empty array, so a pool-only grant works", () => {
    // Found live: `ctxd pool grant <pool> <scope> --level write` plus `ctxd persona issue
    // <client> <pool>` (the real onboarding path for a client, not just `ctxd grant`) left every
    // hook-driven brief throwing SCOPE_FORBIDDEN, since assumedPools was hardcoded to []
    // regardless of any persona token the client had actually been issued.
    const f = setup();
    const poolScopeId = newId();
    f.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'pool-notes', ?)").run(poolScopeId, now());
    f.db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
    f.db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${f.clientId}`);
    f.db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'write')").run(poolScopeId);
    f.db
      .prepare("INSERT INTO persona_tokens (token_hash, client_id, pools, node_id, created_at) VALUES (?, ?, '[\"pool-dev\"]', ?, ?)")
      .run(newId(), f.clientId, f.nodeId, now());

    writeEntry(
      { db: f.db, clock: new HlcClock(f.nodeId), nodeId: f.nodeId, clientId: f.clientId, assumedPools: ["pool-dev"] },
      { scope: "pool-notes", kind: "status", title: "Status", body: "Pool access works.", request_id: newId() } as never,
    );

    const result = sessionStartBrief(baseCtx(f, { scope: "pool-notes", input: { source: "startup" } }));
    expect(result?.text).toContain("Pool access works.");
    expect(result?.text).not.toContain("ctxd unavailable");
  });
});
