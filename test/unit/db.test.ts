import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { checkDatabaseIntegrity, openDatabase } from "../../src/store/db.js";
import { SCHEMA_VERSION } from "../../src/store/schema.js";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxd-db-"));
  return join(dir, "ctxd.db");
}

describe("openDatabase (SPEC v6 section 4)", () => {
  it("refuses to create a fresh database unless create is set", () => {
    const path = tmpDbPath();
    expect(() => openDatabase(path)).toThrow(/not found/);
  });

  it("initializes a fresh file in WAL mode with the schema applied", () => {
    const path = tmpDbPath();
    const db = openDatabase(path, { create: true });
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("entries");
    expect(tables).toContain("events");
    db.close();
  });

  it("reopens an existing database without re-applying the schema", () => {
    const path = tmpDbPath();
    const first = openDatabase(path, { create: true });
    first.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES ('n1','air','home','t')").run();
    first.close();

    const second = openDatabase(path);
    const row = second.prepare("SELECT name FROM nodes WHERE node_id = 'n1'").get() as { name: string } | undefined;
    expect(row?.name).toBe("air");
    second.close();
  });

  it("refuses to open a database at a newer or unknown schema version", () => {
    const path = tmpDbPath();
    const db = openDatabase(path, { create: true });
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    expect(() => openDatabase(path)).toThrow(/schema version/);
  });

  it("migrates a version-19 database by adding peer_watermarks (W3)", () => {
    const path = tmpDbPath();
    const fresh = openDatabase(path, { create: true });
    fresh.exec("DROP TABLE peer_watermarks");
    fresh.pragma("user_version = 19");
    fresh.close();

    const migrated = openDatabase(path);
    expect(migrated.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    migrated.prepare("INSERT INTO peer_watermarks (peer_id, origin_node, through_seq, updated_at) VALUES ('p1', 'o1', 5, 't')").run();
    const row = migrated.prepare("SELECT through_seq FROM peer_watermarks WHERE peer_id = 'p1'").get() as { through_seq: number };
    expect(row.through_seq).toBe(5);
    migrated.close();
  });

  it("enforces foreign keys", () => {
    const path = tmpDbPath();
    const db = openDatabase(path, { create: true });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          "INSERT INTO entries (entry_id, scope_id, kind, slug, title, summary, body, content_rev, content_version, status, status_rev, relations_rev, created_by, updated_by, created_hlc, updated_hlc) VALUES ('e1','missing-scope','note','n-abcdef','t','s','b','1-a',1,'active','1-a','1-a','c','c','h','h')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("matches better-sqlite3's own Database type", () => {
    const path = tmpDbPath();
    const db = openDatabase(path, { create: true });
    expect(db).toBeInstanceOf(Database);
    db.close();
  });
});

describe("checkDatabaseIntegrity (SPEC v8 section 12's startup integrity)", () => {
  it("reports ok for a freshly initialized database", () => {
    const db = openDatabase(tmpDbPath(), { create: true });
    expect(checkDatabaseIntegrity(db)).toEqual({ ok: true });
    db.close();
  });

  it("reports ok after real data has been written", () => {
    const db = openDatabase(tmpDbPath(), { create: true });
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES ('n1','air','home','t')").run();
    expect(checkDatabaseIntegrity(db).ok).toBe(true);
    db.close();
  });

  it("fails and points to ctxd doctor and ctxd restore when the file is corrupted", () => {
    const path = tmpDbPath();
    openDatabase(path, { create: true }).close();
    // Corrupt the file on disk directly, bypassing SQLite entirely, same as real disk damage would.
    const fd = openSync(path, "r+");
    const garbage = Buffer.from("not a valid sqlite page");
    writeSync(fd, garbage, 0, garbage.length, 100);
    closeSync(fd);

    const db = new Database(path);
    const result = checkDatabaseIntegrity(db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ctxd doctor");
    expect(result.reason).toContain("ctxd restore");
    db.close();
  });
});
