import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";
import { configSchema } from "../../src/config/config.js";
import { gatherStatus, formatStatusLine, formatStatusDetail } from "../../src/cli/status.js";
import { LocalDirInboxTransport } from "../../src/inbox/localDirTransport.js";

/** `ctxd status` / `ctxd statusline` (SPEC v8 9.11, M4 slice 5): one scratch database per test,
 * an injected `fetch` so no test depends on a real server actually listening. */

function freshDb() {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxd-status-"));
  return openDatabase(join(dataDir, "ctxd.db"), { create: true });
}

function baseConfig(overrides: Partial<Parameters<typeof configSchema.parse>[0]> = {}) {
  return configSchema.parse({ node: { name: "n", role: "home" }, ...overrides });
}

function okFetch(): typeof fetch {
  return (async () => new Response("ok", { status: 200 })) as typeof fetch;
}

function downFetch(): typeof fetch {
  return (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;
}

describe("gatherStatus", () => {
  it("reports healthy, no scope, and nothing to sync for a fresh database with no scope_map entry", async () => {
    const db = freshDb();
    const config = baseConfig();
    const info = await gatherStatus(db, config, { cwd: "/tmp/not-a-git-repo-and-not-mapped", fetchImpl: okFetch() });
    expect(info.healthOk).toBe(true);
    expect(info.scope).toBeNull();
    expect(info.briefAvailable).toBe(false);
    expect(info.openClaims).toBe(0);
    expect(info.unsynced).toBe(0);
    db.close();
  });

  it("reports unhealthy when the health check fails", async () => {
    const db = freshDb();
    const info = await gatherStatus(db, baseConfig(), { cwd: "/tmp/x", fetchImpl: downFetch() });
    expect(info.healthOk).toBe(false);
    db.close();
  });

  it("resolves a scope from scope_map and counts its open claims", async () => {
    const db = freshDb();
    const scopeId = randomUUID();
    db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', datetime('now'))").run(scopeId);
    db.prepare(
      "INSERT INTO leases (task_id, scope_id, holder, state, claim_event, claim_hlc, earliest_claim_hlc, expires_at, last_activity_hlc) VALUES (?, ?, 'agent-1', 'active', 'e1', 'h1', 'h1', datetime('now', '+1 hour'), 'h1')",
    ).run(randomUUID(), scopeId);
    db.prepare(
      "INSERT INTO leases (task_id, scope_id, holder, state, claim_event, claim_hlc, earliest_claim_hlc, expires_at, last_activity_hlc) VALUES (?, ?, 'agent-1', 'released', 'e2', 'h2', 'h2', datetime('now', '+1 hour'), 'h2')",
    ).run(randomUUID(), scopeId);

    const config = baseConfig({ scope_map: { "/tmp/notes-project": "notes" } });
    const info = await gatherStatus(db, config, { cwd: "/tmp/notes-project", fetchImpl: okFetch() });
    expect(info.scope).toBe("notes");
    expect(info.openClaims).toBe(1);
    expect(info.briefAvailable).toBe(true);
    db.close();
  });

  it("reports brief unavailable when hooks.session_start is off, even with a resolved scope", async () => {
    const db = freshDb();
    db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', datetime('now'))").run(randomUUID());
    const config = baseConfig({ scope_map: { "/tmp/notes-project": "notes" }, features: { "hooks.session_start": false } });
    const info = await gatherStatus(db, config, { cwd: "/tmp/notes-project", fetchImpl: okFetch() });
    expect(info.briefAvailable).toBe(false);
    db.close();
  });

  it("reports unsynced as untracked when sync is on and peers exist", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at) VALUES (?, 'laptop', 'https://laptop.example/sync', 'home', 'h', datetime('now'))",
    ).run(randomUUID());
    const config = baseConfig({ features: { sync: true } });
    const info = await gatherStatus(db, config, { cwd: "/tmp/x", fetchImpl: okFetch() });
    expect(info.unsynced).toBeNull();
    expect(info.peerCount).toBe(1);
    db.close();
  });

  it("reports inboxPending as 0 when mobile_inbox is off", async () => {
    const db = freshDb();
    const info = await gatherStatus(db, baseConfig(), { cwd: "/tmp/x", fetchImpl: okFetch() });
    expect(info.inboxPending).toBe(0);
    db.close();
  });

  it("reports a real inboxPending count for the local transport when mobile_inbox is on", async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "ctxd-status-inbox-"));
    new LocalDirInboxTransport(dir).capture("a", { scope: "sample-app", kind: "note", title: "t", body: "b", capturedAt: "2026-10-20T00:00:00.000Z" });
    const config = baseConfig({ features: { mobile_inbox: true }, inbox: { transport: "local", dir, endpoint: "", pull_limit: 50, publish_scopes: [] } });
    const info = await gatherStatus(db, config, { cwd: "/tmp/x", fetchImpl: okFetch() });
    expect(info.inboxPending).toBe(1);
    db.close();
  });

  it("reports inboxPending as null for the cloudflare transport (a network call would violate statusline's budget)", async () => {
    const db = freshDb();
    const config = baseConfig({ features: { mobile_inbox: true }, inbox: { transport: "cloudflare", dir: "/tmp/unused", endpoint: "https://inbox.example.workers.dev", pull_limit: 50, publish_scopes: [] } });
    const info = await gatherStatus(db, config, { cwd: "/tmp/x", fetchImpl: okFetch() });
    expect(info.inboxPending).toBeNull();
    db.close();
  });
});

describe("formatStatusLine", () => {
  it("matches the spec's own example shape", () => {
    const line = formatStatusLine({ healthOk: true, scope: "ctxd", scopeNotice: null, briefAvailable: true, openClaims: 2, unsynced: 3, peerCount: 1, inboxPending: 0 });
    expect(line).toBe("ctxd ● ctxd · brief ✓ · 2 claims · 3 unsynced");
  });

  it("shows the down indicator and a crossed-out brief when unhealthy and unavailable", () => {
    const line = formatStatusLine({ healthOk: false, scope: null, scopeNotice: "not bound", briefAvailable: false, openClaims: 0, unsynced: 0, peerCount: 0, inboxPending: 0 });
    expect(line).toContain("○");
    expect(line).toContain("brief ✗");
    expect(line).toContain("no scope");
  });
});

describe("formatStatusDetail", () => {
  it("includes the untracked-sync note when unsynced is null", () => {
    const detail = formatStatusDetail({ healthOk: true, scope: "ctxd", scopeNotice: null, briefAvailable: true, openClaims: 0, unsynced: null, peerCount: 2, inboxPending: 0 });
    expect(detail).toContain("not tracked yet");
    expect(detail).toContain("2 peer(s)");
  });
});
