import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../store/schema.js";
import type { SealedKeyProvider } from "./key-provider.js";
import { loadVecExtension, VEC0_TABLE_SQL } from "../embed/vec.js";

export interface SealedDatabaseProvider {
  open(path: string, key: Buffer, create: boolean): Database.Database;
}

export class SqlCipherDatabaseProvider implements SealedDatabaseProvider {
  open(path: string, key: Buffer, create: boolean): Database.Database {
    const require = createRequire(import.meta.url);
    let Driver: typeof BetterSqlite3;
    try { Driver = require("better-sqlite3-multiple-ciphers") as typeof BetterSqlite3; }
    catch { throw new Error("sealed pools require better-sqlite3-multiple-ciphers 13.0.3"); }
    if (!create && !existsSync(path)) throw new Error(`sealed database not found: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    const db = new Driver(path);
    db.pragma("cipher_compatibility = 4");
    db.pragma(`key = "x'${key.toString("hex")}'"`);
    loadVecExtension(db);
    if (create && (db.pragma("user_version", { simple: true }) as number) === 0) {
      db.exec(SCHEMA_SQL);
      db.exec(VEC0_TABLE_SQL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    return db;
  }
}

export class TestDatabaseProvider implements SealedDatabaseProvider {
  open(path: string, _key: Buffer, create: boolean): Database.Database {
    if (!create && !existsSync(path)) throw new Error(`sealed database not found: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    const db = new BetterSqlite3(path);
    loadVecExtension(db);
    if (create && (db.pragma("user_version", { simple: true }) as number) === 0) {
      db.exec(SCHEMA_SQL);
      db.exec(VEC0_TABLE_SQL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    return db;
  }
}

const ENTRY_TABLES = ["relations", "flags", "read_stats", "signals", "embeddings", "entry_siblings", "leases"] as const;

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);
}

function copyRows(source: Database.Database, target: Database.Database, table: string, where: string, args: unknown[]): void {
  const cols = columns(source, table);
  if (!cols.length || !columns(target, table).length) return;
  const rows = source.prepare(`SELECT ${cols.join(",")} FROM ${table} WHERE ${where}`).all(...args) as Record<string, unknown>[];
  if (!rows.length) return;
  const insert = target.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  target.transaction(() => { for (const row of rows) insert.run(...cols.map((col) => row[col])); })();
}

function scopeIds(db: Database.Database, poolId: string): string[] {
  return (db.prepare("SELECT scope_id FROM pool_grants WHERE pool_id = ?").all(poolId) as { scope_id: string }[]).map((row) => row.scope_id);
}

function transferContent(source: Database.Database, target: Database.Database, scopes: string[]): void {
  if (!scopes.length) return;
  const marks = scopes.map(() => "?").join(",");
  copyRows(source, target, "scopes", `scope_id IN (${marks})`, scopes);
  copyRows(source, target, "entries", `scope_id IN (${marks})`, scopes);
  copyRows(source, target, "events", `scope_id IN (${marks})`, scopes);
  const entryIds = (source.prepare(`SELECT entry_id FROM entries WHERE scope_id IN (${marks})`).all(...scopes) as { entry_id: string }[]).map((row) => row.entry_id);
  if (entryIds.length) {
    const entryMarks = entryIds.map(() => "?").join(",");
    for (const table of ENTRY_TABLES) {
      const key = table === "leases" ? "task_id" : "entry_id";
      copyRows(source, target, table, `${key} IN (${entryMarks})`, entryIds);
    }
  }
}

function eraseContent(db: Database.Database, scopes: string[]): void {
  if (!scopes.length) return;
  const marks = scopes.map(() => "?").join(",");
  const ids = (db.prepare(`SELECT entry_id FROM entries WHERE scope_id IN (${marks})`).all(...scopes) as { entry_id: string }[]).map((row) => row.entry_id);
  db.transaction(() => {
    if (ids.length) {
      const entryMarks = ids.map(() => "?").join(",");
      for (const table of ENTRY_TABLES) {
        const key = table === "leases" ? "task_id" : "entry_id";
        db.prepare(`DELETE FROM ${table} WHERE ${key} IN (${entryMarks})`).run(...ids);
      }
    }
    db.prepare(`DELETE FROM events WHERE scope_id IN (${marks})`).run(...scopes);
    db.prepare(`DELETE FROM entries WHERE scope_id IN (${marks})`).run(...scopes);
  })();
}

export class SealedPoolStore {
  private readonly openPools = new Map<string, { db: Database.Database; expiresAt: number }>();
  constructor(
    private readonly main: Database.Database,
    private readonly dataDir: string,
    private readonly keys: SealedKeyProvider,
    private readonly databases: SealedDatabaseProvider,
    private readonly unlockMinutes = 60,
  ) {}

  seal(poolId: string, nodeId: string): string {
    const pool = this.main.prepare("SELECT storage FROM pools WHERE pool_id = ?").get(poolId) as { storage: string } | undefined;
    if (!pool) throw new Error(`pool not found: ${poolId}`);
    if (pool.storage === "sealed") throw new Error("pool is already sealed");
    const relative = `sealed/${poolId}.db`;
    const key = this.keys.create(poolId);
    const sealed = this.databases.open(`${this.dataDir}/${relative}`, key, true);
    const scopes = scopeIds(this.main, poolId);
    transferContent(this.main, sealed, scopes);
    eraseContent(this.main, scopes);
    sealed.close();
    void nodeId;
    return relative;
  }

  unlock(poolId: string): void {
    const existing = this.openPools.get(poolId);
    if (existing) { existing.expiresAt = Date.now() + this.unlockMinutes * 60_000; return; }
    const pool = this.main.prepare("SELECT sealed_file FROM pools WHERE pool_id = ? AND storage = 'sealed'").get(poolId) as { sealed_file: string } | undefined;
    if (!pool?.sealed_file) throw new Error("sealed pool not found");
    const sealed = this.databases.open(`${this.dataDir}/${pool.sealed_file}`, this.keys.get(poolId), false);
    const scopes = scopeIds(this.main, poolId);
    transferContent(sealed, this.main, scopes);
    this.openPools.set(poolId, { db: sealed, expiresAt: Date.now() + this.unlockMinutes * 60_000 });
  }

  lock(poolId: string): void {
    let opened = this.openPools.get(poolId);
    if (!opened) {
      const pool = this.main.prepare("SELECT sealed_file FROM pools WHERE pool_id = ? AND storage = 'sealed'").get(poolId) as { sealed_file: string } | undefined;
      if (!pool?.sealed_file) return;
      opened = { db: this.databases.open(`${this.dataDir}/${pool.sealed_file}`, this.keys.get(poolId), false), expiresAt: 0 };
    }
    const scopes = scopeIds(this.main, poolId);
    transferContent(this.main, opened.db, scopes);
    eraseContent(this.main, scopes);
    opened.db.close();
    this.openPools.delete(poolId);
  }

  lockExpired(now = Date.now()): string[] {
    const locked: string[] = [];
    for (const [poolId, state] of this.openPools) if (state.expiresAt <= now) { this.lock(poolId); locked.push(poolId); }
    return locked;
  }

  enroll(poolId: string, nodeId: string): void {
    this.keys.get(poolId);
    void nodeId;
  }

  isUnlocked(poolId: string): boolean { return this.openPools.has(poolId); }
  close(): void { for (const poolId of [...this.openPools.keys()]) this.lock(poolId); }
}
