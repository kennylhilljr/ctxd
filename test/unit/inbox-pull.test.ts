import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { FakeInboxTransport } from "../../src/inbox/fakeTransport.js";
import { runInboxPull } from "../../src/inbox/pull.js";

/**
 * Slice 3: the hub pull engine applies allowlisted entries as `proposed`, holds entries for
 * scopes the mobile-inbox client has no grant for, and hard-rejects sealed/local-only/home scopes,
 * oversized payloads and invalid entries (PRD-mobile-inbox-v1 MI-3, MI-5, MI-6, MI-7).
 */

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
  clientId: string;
  allowedScopeId: string;
  homeScopeId: string;
}

function setup(): Fixture {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ctxd-inbox-pull-")), "ctxd.db"), { create: true });
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());

  const allowedScopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(allowedScopeId, now());
  const holdOnlyScopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'project-b', ?)").run(holdOnlyScopeId, now());
  const homeScopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, replication, created_at) VALUES (?, 'pool-private', 'home', ?)").run(homeScopeId, now());

  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'mobile-inbox', 'other', ?, ?, ?)").run(
    clientId,
    nodeId,
    newId(),
    now(),
  );
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${clientId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'propose')").run(allowedScopeId);
  // holdOnlyScopeId deliberately has no grant at all for mobile-inbox.

  return { db, nodeId, clientId, allowedScopeId, homeScopeId };
}

const FLAGS_ON = new Map([["mobile_inbox", true]]);

function capture(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return { scope: "sample-app", kind: "note", title: "Call back the dentist", body: "Reminder from the mobile app.", capturedAt: "2026-10-20T12:00:00.000Z", ...overrides };
}

describe("runInboxPull", () => {
  it("makes zero transport calls when mobile_inbox is off", async () => {
    const f = setup();
    let pullCalls = 0;
    const transport = new FakeInboxTransport();
    const realPull = transport.pull.bind(transport);
    transport.pull = (async (limit: number) => {
      pullCalls++;
      return realPull(limit);
    }) as typeof transport.pull;

    const outcome = await runInboxPull(f.db, f.nodeId, f.clientId, transport, new Map([["mobile_inbox", false]]));
    expect(outcome).toEqual({ fetched: 0, applied: 0, held: 0, rejected: 0, errored: 0 });
    expect(pullCalls).toBe(0);
  });

  it("applies an entry for an allowlisted scope as proposed, tagged with its origin", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    transport.seed("evt-1", capture());

    const outcome = await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);
    expect(outcome).toEqual({ fetched: 1, applied: 1, held: 0, rejected: 0, errored: 0 });
    expect(await transport.status()).toEqual({ pending: 0 }); // acked

    const row = f.db.prepare("SELECT status, tags, created_by FROM entries WHERE scope_id = ?").get(f.allowedScopeId) as {
      status: string;
      tags: string;
      created_by: string;
    };
    expect(row.status).toBe("proposed");
    expect(row.created_by).toBe(f.clientId);
    expect(JSON.parse(row.tags)).toContain("origin:mobile-inbox");
  });

  it("holds an entry for a scope the client has no grant for, rather than applying or silently dropping it", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    transport.seed("evt-1", capture({ scope: "project-b" }));

    const outcome = await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);
    expect(outcome).toEqual({ fetched: 1, applied: 0, held: 1, rejected: 0, errored: 0 });
    const held = f.db.prepare("SELECT status FROM entries").all() as { status: string }[];
    expect(held.map((r) => r.status)).toEqual(["proposed"]); // the holding scope's own copy
  });

  it("rejects a home-replication scope outright, without holding it for review (MI-7)", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    transport.seed("evt-1", capture({ scope: "pool-private" }));

    const outcome = await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);
    expect(outcome).toEqual({ fetched: 1, applied: 0, held: 0, rejected: 1, errored: 0 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
    const rejection = f.db.prepare("SELECT code FROM rejections").get() as { code: string };
    expect(rejection.code).toBe("INBOX_SCOPE_EXCLUDED");
  });

  it("rejects an entry that fails schema validation, and still acks it so it doesn't jam the queue", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    transport.seed("evt-1", { scope: "sample-app" }); // missing required fields

    const outcome = await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);
    expect(outcome).toEqual({ fetched: 1, applied: 0, held: 0, rejected: 1, errored: 0 });
    expect(await transport.status()).toEqual({ pending: 0 });
  });

  it("rejects a body over the 16 KB bound (MI-5)", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    transport.seed("evt-1", capture({ body: "x".repeat(16 * 1024 + 1) }));

    const outcome = await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);
    expect(outcome.rejected).toBe(1);
    expect(outcome.applied).toBe(0);
  });

  it("is idempotent: re-pulling the same inboxEntryId after it was applied is a no-op, not a duplicate", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    transport.seed("evt-1", capture());
    await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);

    transport.seed("evt-1", capture()); // simulates a re-delivery of the same id (at-least-once)
    const second = await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);
    expect(second.applied).toBe(1); // writeEntry's own idempotency replay still counts as "applied", not an error
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 1 }); // but only one entry ever exists
  });
});
