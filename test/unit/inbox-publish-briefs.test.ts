import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { FakeInboxTransport } from "../../src/inbox/fakeTransport.js";
import { runPublishBriefs } from "../../src/inbox/publishBriefs.js";

/** Slice 6 (PRD-mobile-inbox-v1 MI-9): publishing is off by default (D2), and even when
 * allowlisted, sealed/local-only/home scopes are never pushed (M7 kickoff section 2). */

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
  humanId: string;
}

function setup(): Fixture {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ctxd-inbox-briefs-")), "ctxd.db"), { create: true });
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(newId(), now());
  db.prepare("INSERT INTO scopes (scope_id, name, vendor_policy, created_at) VALUES (?, 'private-a', 'local-only', ?)").run(newId(), now());
  db.prepare("INSERT INTO scopes (scope_id, name, replication, created_at) VALUES (?, 'pool-private', 'home', ?)").run(newId(), now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now());
  return { db, nodeId, humanId };
}

describe("runPublishBriefs", () => {
  it("publishes nothing when mobile_inbox.publish_briefs is off, even with a non-empty allowlist", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    const outcome = await runPublishBriefs(f.db, f.nodeId, f.humanId, ["sample-app"], transport, new Map([["mobile_inbox.publish_briefs", false]]));
    expect(outcome).toEqual({ published: 0, skipped: 0 });
    expect(transport.publishedBriefs).toEqual([]);
  });

  it("publishes nothing when the allowlist is empty (D2's default), even with the flag on", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    const outcome = await runPublishBriefs(f.db, f.nodeId, f.humanId, [], transport, new Map([["mobile_inbox.publish_briefs", true]]));
    expect(outcome).toEqual({ published: 0, skipped: 0 });
  });

  it("publishes an allowlisted ordinary scope", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    const flags = new Map([["mobile_inbox.publish_briefs", true]]);
    const outcome = await runPublishBriefs(f.db, f.nodeId, f.humanId, ["sample-app"], transport, flags);
    expect(outcome).toEqual({ published: 1, skipped: 0 });
    expect(transport.publishedBriefs).toHaveLength(1);
    expect(transport.publishedBriefs[0]?.scope).toBe("sample-app");
  });

  it("skips a local-only scope and a home-replication scope even when allowlisted", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    const flags = new Map([["mobile_inbox.publish_briefs", true]]);
    const outcome = await runPublishBriefs(f.db, f.nodeId, f.humanId, ["private-a", "pool-private"], transport, flags);
    expect(outcome).toEqual({ published: 0, skipped: 2 });
    expect(transport.publishedBriefs).toEqual([]);
  });

  it("a sealed pool's scope is never even a candidate, since it never appears in the main scopes table", async () => {
    // Sealed pool scopes live only inside the pool's own encrypted file (src/sealed/store.ts),
    // never in the main database's `scopes` table, so loadScopeExclusionRow returns null for one
    // -- the same "skip, don't crash" path as any other unknown or mistyped scope name.
    const f = setup();
    const transport = new FakeInboxTransport();
    const flags = new Map([["mobile_inbox.publish_briefs", true]]);
    const outcome = await runPublishBriefs(f.db, f.nodeId, f.humanId, ["sample-app", "not-a-real-sealed-scope"], transport, flags);
    expect(outcome).toEqual({ published: 1, skipped: 1 });
  });
});
