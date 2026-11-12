import Database from "better-sqlite3";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { SCHEMA_VERSION } from "../../src/store/schema.js";
import { needsUpgrade, upgradeDatabase } from "../../src/store/upgrade.js";
import { writeEntry } from "../../src/store/write.js";

/**
 * `ctxd upgrade` (src/store/upgrade.ts): recovering a database older than the migration chain's
 * first step by replaying its event log into a fresh one. The fixture builds a real database, then
 * ages it the way test/unit/db.test.ts simulates older versions: drop columns a later schema added
 * and roll `user_version` back.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ctxd-upgrade-"));
}

interface Legacy {
  dir: string;
  source: string;
  poolId: string;
  entryIds: string[];
}

/** A database with content, a pool and its grants, aged to look like schema 7: no acl events, and without the columns later schemas added. */
function legacyDatabase(): Legacy {
  const dir = scratch();
  const source = join(dir, "ctxd.db");
  const db = openDatabase(source, { create: true });
  const nodeId = newId();
  const humanId = newId();
  const scopeId = newId();
  const poolId = newId();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now);
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now);
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(scopeId, now);
  // Written directly, with no acl event, exactly as an M1-era database did.
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES (?, 'pool-dev', ?)").run(poolId, now);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, 'write')").run(poolId, scopeId);
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES (?, ?)").run(poolId, `client:${humanId}`);

  const ctx = { db, clock: new HlcClock(nodeId), nodeId, clientId: humanId };
  const entryIds: string[] = [];
  for (const title of ["First note", "Second note", "Third note"]) {
    const written = writeEntry(ctx, { scope: "notes", kind: "note", title, body: `${title} body.`, request_id: newId() } as never);
    if ("held" in written) throw new Error("unexpected hold");
    entryIds.push(written.id);
  }
  db.exec("ALTER TABLE entries DROP COLUMN origin"); // added at schema 23
  db.exec("ALTER TABLE sessions DROP COLUMN cwd"); // added at schema 20
  db.pragma("user_version = 7");
  db.close();
  return { dir, source, poolId, entryIds };
}

describe("needsUpgrade", () => {
  it("covers only the versions the migration chain cannot reach", () => {
    expect(needsUpgrade(7)).toBe(true);
    expect(needsUpgrade(12)).toBe(true);
    expect(needsUpgrade(13)).toBe(false); // the chain's first step
    expect(needsUpgrade(SCHEMA_VERSION)).toBe(false);
    expect(needsUpgrade(0)).toBe(false); // an empty file is ctxd init's business, not this
  });
});

describe("upgradeDatabase", () => {
  it("replays a legacy database into the current schema, keeping its content", () => {
    const legacy = legacyDatabase();
    const target = join(legacy.dir, "upgraded.db");

    const report = upgradeDatabase(legacy.source, target);

    expect(report.fromVersion).toBe(7);
    expect(report.toVersion).toBe(SCHEMA_VERSION);
    expect(report.entries).toBe(3);

    const upgraded = openDatabase(target);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    for (const id of legacy.entryIds) {
      const row = upgraded.prepare("SELECT title, body, origin FROM entries WHERE entry_id = ?").get(id) as { title: string; body: string; origin: string | null };
      expect(row.title).toMatch(/note$/);
      expect(row.body).not.toBe("");
      expect(row.origin).toBeNull(); // the column the old file never had
    }
    upgraded.close();
  });

  it("restores pools, grants and members that predate acl events, which the replay would otherwise wipe", () => {
    const legacy = legacyDatabase();
    const target = join(legacy.dir, "upgraded.db");

    const report = upgradeDatabase(legacy.source, target);

    // rebuild() deletes these to reconstruct them from acl events; a legacy database has none, so
    // without the post-replay restore the pool and its access would silently disappear.
    expect(report.aclRowsRestored).toBe(3);
    const upgraded = openDatabase(target);
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM pools").get() as { n: number }).n).toBe(1);
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM pool_grants").get() as { n: number }).n).toBe(1);
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM pool_members").get() as { n: number }).n).toBe(1);
    upgraded.close();
  });

  it("reports columns the current schema no longer has, rather than failing on them", () => {
    const legacy = legacyDatabase();
    const db = new Database(legacy.source);
    db.exec("ALTER TABLE nodes ADD COLUMN peer_token_hash TEXT"); // removed at schema 8
    db.close();

    const report = upgradeDatabase(legacy.source, join(legacy.dir, "upgraded.db"));
    const nodes = report.carried.find((t) => t.table === "nodes");
    expect(nodes?.droppedColumns).toContain("peer_token_hash");
  });

  it("never writes to the source", () => {
    const legacy = legacyDatabase();
    upgradeDatabase(legacy.source, join(legacy.dir, "upgraded.db"));

    const source = new Database(legacy.source, { readonly: true });
    expect(source.pragma("user_version", { simple: true })).toBe(7);
    // The column a current schema would have added is still absent: nothing migrated it in place.
    expect((source.pragma("table_info(entries)") as { name: string }[]).some((c) => c.name === "origin")).toBe(false);
    source.close();
  });

  it("leaves the migration chain's own range to the chain", () => {
    const legacy = legacyDatabase();
    const db = new Database(legacy.source);
    db.pragma("user_version = 22");
    db.close();
    // 22 is inside the chain, so opening it migrates normally and never needs this command.
    const opened = openDatabase(legacy.source);
    expect(opened.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    opened.close();
  });

  it("refuses a version below the chain with a message pointing at ctxd upgrade", () => {
    const legacy = legacyDatabase();
    expect(() => openDatabase(legacy.source)).toThrow(/ctxd upgrade --from/);
    expect(existsSync(legacy.source)).toBe(true);
  });
});
