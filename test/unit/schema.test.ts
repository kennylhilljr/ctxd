import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../../src/store/schema.js";

describe("schema (SPEC v5 section 4)", () => {
  it("applies cleanly to an empty SQLite database", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ["events", "entries", "relations", "scope_repos", "rejections", "leases", "claim_overlaps", "sessions", "sync_state", "pools", "pool_grants", "pool_members", "client_grants", "access_requests", "flags", "batches", "batch_members", "read_stats", "persona_tokens", "persona_prefs", "pool_enrollments"]) {
      expect(tables).toContain(t);
    }
  });

  it("accepts the lesson kind and rejects unknown kinds", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES ('s1','ctxd','t')").run();
    const insert = db.prepare(
      `INSERT INTO entries (entry_id, scope_id, kind, title, summary, body, content_rev, content_version, status, status_rev, relations_rev, created_by, updated_by, created_hlc, updated_hlc)
       VALUES (?, 's1', ?, 't', 's', 'b', '1-a', 1, 'proposed', '1-a', '1-a', 'c', 'c', 'h', 'h')`,
    );
    expect(() => insert.run("e1", "lesson")).not.toThrow();
    expect(() => insert.run("e2", "opinion")).toThrow();
  });
});
