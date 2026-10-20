import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { configSchema } from "../../src/config/config.js";
import { FakeInboxTransport } from "../../src/inbox/fakeTransport.js";
import { runPull, runStatus } from "../../src/cli/inbox.js";

/** Slice 7: `ctxd inbox pull` / `ctxd inbox status` CLI wiring (MI-11), against a fake transport. */

function now(): string {
  return new Date().toISOString();
}

function baseConfig(overrides: Partial<Parameters<typeof configSchema.parse>[0]> = {}) {
  return configSchema.parse({ node: { name: "n", role: "home" }, ...overrides });
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
}

function setup(): Fixture {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ctxd-cli-inbox-")), "ctxd.db"), { create: true });
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(scopeId, now());
  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'mobile-inbox', 'other', ?, ?, ?)").run(clientId, nodeId, newId(), now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now());
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${clientId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'propose')").run(scopeId);
  return { db, nodeId };
}

describe("runPull", () => {
  it("makes no transport calls and returns 0 when mobile_inbox is off", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    const code = await runPull(f.db, f.nodeId, baseConfig(), transport);
    expect(code).toBe(0);
    expect(await transport.status()).toEqual({ pending: 0 });
  });

  it("fails clearly when the mobile-inbox client doesn't exist yet", async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ctxd-cli-inbox-")), "ctxd.db"), { create: true });
    const nodeId = newId();
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
    const transport = new FakeInboxTransport();
    await expect(runPull(db, nodeId, baseConfig({ features: { mobile_inbox: true } }), transport)).rejects.toThrow("ctxd client add mobile-inbox");
  });

  it("pulls and applies an entry for an allowlisted scope", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    transport.seed("evt-1", { scope: "sample-app", kind: "note", title: "t", body: "b", capturedAt: "2026-10-20T00:00:00.000Z" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runPull(f.db, f.nodeId, baseConfig({ features: { mobile_inbox: true } }), transport);
    log.mockRestore();
    expect(code).toBe(0);
    expect(await transport.status()).toEqual({ pending: 0 });
  });
});

describe("runStatus", () => {
  it("reports mobile_inbox off without calling the transport", async () => {
    const transport = new FakeInboxTransport([{ inboxEntryId: "a", raw: {} }]);
    const statusSpy = vi.spyOn(transport, "status");
    const code = await runStatus(baseConfig(), transport);
    expect(code).toBe(0);
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("reports the transport's pending count when mobile_inbox is on", async () => {
    const transport = new FakeInboxTransport([{ inboxEntryId: "a", raw: {} }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runStatus(baseConfig({ features: { mobile_inbox: true } }), transport);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("pending=1"));
    log.mockRestore();
  });
});
