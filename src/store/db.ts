import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

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
export function openDatabase(path: string, { create = false }: OpenDatabaseOptions = {}): Database.Database {
  if (!create && !existsSync(path)) {
    throw new Error(`Database not found at ${path}. Run "ctxd init" to create one.`);
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version === 0) {
    if (!create) {
      db.close();
      throw new Error(`Database at ${path} has no schema applied; refusing to initialize it outside "ctxd init".`);
    }
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  } else if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database schema version ${version} does not match ${SCHEMA_VERSION}; no migration is defined yet.`);
  }
  return db;
}
