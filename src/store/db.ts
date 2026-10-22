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

/**
 * The linear schema migration chain, applied to any ctxd database: the main one and, since W10's
 * review, each sealed pool file too (`src/sealed/store.ts`). A sealed file used to get its schema
 * once at creation and never again, so a pool sealed before a schema bump stayed at its old
 * version and the first write that needed a newly added column failed inside the encrypted file.
 *
 * Every step is `if (version === N && SCHEMA_VERSION >= N + 1)`, re-reading the version between
 * steps, so a database several versions behind walks forward one step at a time. A version this
 * chain has no step for is refused rather than guessed at, and the handle is closed first so no
 * caller is left holding an unusable database.
 */
export function migrateSchema(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version === 13 && SCHEMA_VERSION >= 14) {
    db.transaction(() => {
      db.exec("ALTER TABLE events ADD COLUMN payload_hash TEXT; ALTER TABLE events ADD COLUMN signature TEXT; ALTER TABLE events ADD COLUMN public_key TEXT;");
      db.exec("CREATE TABLE node_keys (node_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, first_seen_at TEXT NOT NULL)");
      db.pragma("user_version = 14");
    })();
  }
  const migratedVersion = db.pragma("user_version", { simple: true }) as number;
  if (migratedVersion === 14 && SCHEMA_VERSION >= 15) {
    db.transaction(() => {
      db.exec("CREATE TABLE mirror_conflicts (path TEXT PRIMARY KEY, entry_id TEXT NOT NULL, file_rev TEXT, current_rev TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)");
      db.exec("CREATE TABLE archive_requests (entry_id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at TEXT NOT NULL)");
      db.pragma("user_version = 15");
    })();
  }
  const mirrorVersion = db.pragma("user_version", { simple: true }) as number;
  if (mirrorVersion === 15 && SCHEMA_VERSION >= 16) {
    db.transaction(() => {
      db.exec("CREATE TABLE sealed_purge_queue (pool_id TEXT NOT NULL, entry_id TEXT NOT NULL, requested_at TEXT NOT NULL, PRIMARY KEY (pool_id, entry_id))");
      db.pragma("user_version = 16");
    })();
  }
  const sealedVersion = db.pragma("user_version", { simple: true }) as number;
  if (sealedVersion === 16 && SCHEMA_VERSION >= 17) {
    db.transaction(() => {
      db.exec("ALTER TABLE events ADD COLUMN prev_hash TEXT; ALTER TABLE node_keys ADD COLUMN first_signed_seq INTEGER NOT NULL DEFAULT 0; ALTER TABLE peers ADD COLUMN remote_node_id TEXT; ALTER TABLE peers ADD COLUMN remote_public_key TEXT;");
      db.pragma("user_version = 17");
    })();
  }
  const finalVersion = db.pragma("user_version", { simple: true }) as number;
  if (finalVersion === 17 && SCHEMA_VERSION >= 18) {
    db.transaction(() => {
      db.exec("ALTER TABLE events ADD COLUMN payload_stripped INTEGER NOT NULL DEFAULT 0");
      db.exec("UPDATE events SET payload_stripped = 1 WHERE payload = '{\"purged\":true}' AND op != 'purge'");
      db.pragma("user_version = 18");
    })();
  }
  const purgeMetadataVersion = db.pragma("user_version", { simple: true }) as number;
  if (purgeMetadataVersion === 18 && SCHEMA_VERSION >= 19) {
    db.transaction(() => {
      db.exec("CREATE TABLE node_origin_sequences (node_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)");
      db.exec("INSERT INTO node_origin_sequences (node_id, next_seq) SELECT origin_node, MAX(origin_seq) FROM events GROUP BY origin_node");
      db.pragma("user_version = 19");
    })();
  }
  const sessionCwdVersion = db.pragma("user_version", { simple: true }) as number;
  if (sessionCwdVersion === 19 && SCHEMA_VERSION >= 20) {
    db.transaction(() => {
      db.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT");
      db.pragma("user_version = 20");
    })();
  }
  const keyTransferVersion = db.pragma("user_version", { simple: true }) as number;
  if (keyTransferVersion === 20 && SCHEMA_VERSION >= 21) {
    db.transaction(() => {
      db.exec("CREATE TABLE node_encryption_keys (node_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, signature TEXT NOT NULL, created_at TEXT NOT NULL)");
      db.exec(
        "CREATE TABLE sealed_key_transfers (transfer_id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, requester_node_id TEXT NOT NULL, source_node_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','approved','fetched','refused')), wrapped_key TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, approved_at TEXT, fetched_at TEXT)",
      );
      db.pragma("user_version = 21");
    })();
  }
  const peerWatermarkVersion = db.pragma("user_version", { simple: true }) as number;
  if (peerWatermarkVersion === 21 && SCHEMA_VERSION >= 22) {
    db.transaction(() => {
      db.exec("CREATE TABLE peer_watermarks (peer_id TEXT NOT NULL, origin_node TEXT NOT NULL, through_seq INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (peer_id, origin_node))");
      db.pragma("user_version = 22");
    })();
  }
  const entryOriginVersion = db.pragma("user_version", { simple: true }) as number;
  if (entryOriginVersion === 22 && SCHEMA_VERSION >= 23) {
    db.transaction(() => {
      db.exec("ALTER TABLE entries ADD COLUMN origin TEXT");
      db.pragma("user_version = 23");
    })();
  }
  const sequenceVersion = db.pragma("user_version", { simple: true }) as number;
  if (sequenceVersion !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database schema version ${sequenceVersion} does not match ${SCHEMA_VERSION}; no migration is defined yet.`);
  }
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
  }
  migrateSchema(db);
  return db;
}
