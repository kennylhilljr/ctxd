import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../../src/store/schema.js";

describe("schema (SPEC v6 section 4)", () => {
  it("applies cleanly to an empty SQLite database", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ["events", "entries", "relations", "scope_repos", "rejections", "leases", "claim_overlaps", "sessions", "sync_state", "pools", "pool_grants", "pool_members", "client_grants", "access_requests", "flags", "batches", "batch_members", "read_stats", "persona_tokens", "persona_prefs", "pool_enrollments", "signals", "skill_syncs", "mirror_files", "tool_metrics"]) {
      expect(tables).toContain(t);
    }
  });

  it("accepts the v6 kinds and rejects unknown kinds", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES ('s1','ctxd','t')").run();
    const insert = db.prepare(
      `INSERT INTO entries (entry_id, scope_id, kind, slug, title, summary, body, content_rev, content_version, status, status_rev, relations_rev, created_by, updated_by, created_hlc, updated_hlc)
       VALUES (?, 's1', ?, 't-abcdef', 't', 's', 'b', '1-a', 1, 'proposed', '1-a', '1-a', 'c', 'c', 'h', 'h')`,
    );
    for (const [i, k] of ["lesson", "preference", "skill", "journal"].entries()) {
      expect(() => insert.run(`e${i}`, k)).not.toThrow();
    }
    expect(() => insert.run("e9", "opinion")).toThrow();
  });

  it("checks journal significance and the new relation types", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES ('s1','notes','t')").run();
    const insert = db.prepare(
      `INSERT INTO entries (entry_id, scope_id, kind, slug, significance, title, summary, body, content_rev, content_version, status, status_rev, relations_rev, created_by, updated_by, created_hlc, updated_hlc)
       VALUES (?, 's1', 'journal', ?, ?, 't', 's', '', '1-a', 1, 'active', '1-a', '1-a', 'c', 'c', 'h', 'h')`,
    );
    expect(() => insert.run("j1", "a-000001", "blocker")).not.toThrow();
    expect(() => insert.run("j2", "a-000002", "urgent")).toThrow();
    // Slugs may collide across nodes (SPEC v6 4.2), so the slug index is not unique.
    expect(() => insert.run("j3", "a-000001", "routine")).not.toThrow();
    const rel = db.prepare("INSERT INTO relations (link_id, entry_id, type, target, added_event) VALUES (?, 'j3', ?, 'ctxd:notes/j1', 'ev')");
    expect(() => rel.run("l1", "resolved")).not.toThrow();
    expect(() => rel.run("l2", "caused")).not.toThrow();
    expect(() => rel.run("l3", "fixes")).toThrow();
    const sig = db.prepare("INSERT INTO signals (entry_id, scope_id, source, opened_hlc) VALUES ('j1', 's1', ?, 'h')");
    expect(() => sig.run("journal")).not.toThrow();
    expect(() => sig.run("flag")).not.toThrow();
    expect(() => sig.run("flag")).toThrow();
  });
});
