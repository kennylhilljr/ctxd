import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { loadVecExtension, VEC0_TABLE_SQL } from "../embed/vec.js";

export interface OpenDatabaseOptions {
  /** Allow initializing a fresh database. Only `ctxd init` passes true (SPEC v6 section 12). */
  create?: boolean;
}

/**
 * Open the node database in WAL mode and apply SCHEMA_SQL (SPEC section 4).
 * Refuses to initialize a fresh database unless `create` is set; an existing
 * one is checked against SCHEMA_VERSION (there is only one version yet, so a
 * mismatch is an error rather than a migration).
 */
export interface IntegrityResult {
  ok: boolean;
  /** Set when `ok` is false: human-readable, pointing to `ctxd doctor` and `ctxd restore`. */
  reason?: string;
}

/**
 * `PRAGMA quick_check` (SPEC v8 section 12's startup integrity): fast, catches most corruption
 * without a full `PRAGMA integrity_check` scan. Severe corruption can make SQLite throw before
 * it ever returns a row (confirmed by directly corrupting a page in a test), so this never lets
 * that propagate; either way is reported the same way, never a crash.
 */
export function checkDatabaseIntegrity(db: Database.Database): IntegrityResult {
  let text: string;
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    text = rows.length === 1 ? rows[0]!.quick_check : rows.map((r) => r.quick_check).join("; ") || "no result";
  } catch (err) {
    text = err instanceof Error ? err.message : String(err);
  }
  if (text !== "ok") {
    return { ok: false, reason: `Database integrity check failed (${text}). Run "ctxd doctor" for details, or "ctxd restore <file>" from a backup.` };
  }
  return { ok: true };
}

export function openDatabase(path: string, { create = false }: OpenDatabaseOptions = {}): Database.Database {
  if (!create && !existsSync(path)) {
    throw new Error(`Database not found at ${path}. Run "ctxd init" to create one.`);
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Loaded unconditionally, independent of semantic_search.compute: every node must be able to
  // store and query vectors that arrive through sync, even one that never computes its own
  // (ADR 0004). No model and no network dependency, so this is always cheap and safe.
  loadVecExtension(db);
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version === 0) {
    if (!create) {
      db.close();
      throw new Error(`Database at ${path} has no schema applied; refusing to initialize it outside "ctxd init".`);
    }
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      db.exec(VEC0_TABLE_SQL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  } else if (version === 13 && SCHEMA_VERSION >= 14) {
    db.transaction(() => {
      db.exec("ALTER TABLE events ADD COLUMN payload_hash TEXT; ALTER TABLE events ADD COLUMN signature TEXT; ALTER TABLE events ADD COLUMN public_key TEXT;");
      db.exec("CREATE TABLE node_keys (node_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, first_seen_at TEXT NOT NULL)");
      db.pragma("user_version = 14");
    })();
  }
  const migratedVersion = db.pragma("user_version", { simple: true }) as number;
  if (migratedVersion === 14 && SCHEMA_VERSION === 15) {
    db.transaction(() => {
      db.exec("CREATE TABLE mirror_conflicts (path TEXT PRIMARY KEY, entry_id TEXT NOT NULL, file_rev TEXT, current_rev TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)");
      db.exec("CREATE TABLE archive_requests (entry_id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at TEXT NOT NULL)");
      db.pragma("user_version = 15");
    })();
  } else if (migratedVersion !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database schema version ${migratedVersion} does not match ${SCHEMA_VERSION}; no migration is defined yet.`);
  }
  return db;
}
