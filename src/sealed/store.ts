import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../store/schema.js";
import type { SealedKeyProvider } from "./key-provider.js";
import { loadVecExtension, VEC0_TABLE_SQL } from "../embed/vec.js";
import { HlcClock } from "../core/hlc.js";
import { purgeEntry } from "../store/purge.js";
import { registerOriginSequenceCoordinator } from "../store/origin-seq.js";

export interface SealedDatabaseProvider {
  open(path: string, key: Buffer, create: boolean): Database.Database;
  /** Re-encrypt an already-open sealed database in place under `newKey`. The handle stays usable afterwards, but `SealedPoolStore.rekey` closes it regardless. */
  rekey(db: Database.Database, newKey: Buffer): void;
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

  /** SQLCipher's own in-place re-encryption. Same quoted-hex form `open` uses for `key`, so a rekeyed file reopens identically with the new key. */
  rekey(db: Database.Database, newKey: Buffer): void {
    db.pragma(`rekey = "x'${newKey.toString("hex")}'"`);
  }
}

export class TestDatabaseProvider implements SealedDatabaseProvider {
  /** Keys this provider was asked to re-encrypt under, in order. The test database is never actually encrypted, so this is how a test observes that the rekey step ran, and with what. */
  readonly rekeyCalls: Buffer[] = [];

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

  rekey(_db: Database.Database, newKey: Buffer): void {
    this.rekeyCalls.push(Buffer.from(newKey));
  }
}

const ENTRY_TABLES =["relations", "flags", "read_stats", "signals", "embeddings", "entry_siblings", "leases"] as const;

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
  const indexed = target.prepare(`SELECT rowid, title, body, tags FROM entries WHERE scope_id IN (${marks})`).all(...scopes) as { rowid: number; title: string; body: string; tags: string }[];
  const insertFts = target.prepare("INSERT INTO entries_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)");
  target.transaction(() => {
    for (const row of indexed) insertFts.run(row.rowid, row.title, row.body, (JSON.parse(row.tags) as string[]).join(" "));
  })();
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

function copyRoutingMetadata(source: Database.Database, target: Database.Database): void {
  for (const table of ["nodes", "node_origin_sequences", "node_keys", "clients", "pools"] as const) {
    copyRows(source, target, table, "1 = 1", []);
  }
}

function copyAccessMetadata(source: Database.Database, target: Database.Database): void {
  copyRows(source, target, "pool_members", "1 = 1", []);
  const scopes = (target.prepare("SELECT scope_id FROM scopes").all() as { scope_id: string }[]).map((row) => row.scope_id);
  if (!scopes.length) return;
  const marks = scopes.map(() => "?").join(",");
  copyRows(source, target, "pool_grants", `scope_id IN (${marks})`, scopes);
  copyRows(source, target, "client_grants", `scope_id IN (${marks})`, scopes);
}

export function createSealedPurgeReplay(
  nodeId: string,
  humanClientId: string,
  flags?: Map<string, boolean>,
): (db: Database.Database, entryId: string) => void {
  return (db, entryId) => {
    purgeEntry({ db, clock: new HlcClock(nodeId), nodeId, clientId: humanClientId, flags }, entryId, "queued while sealed pool was locked");
  };
}

function eraseContent(db: Database.Database, scopes: string[]): void {
  if (!scopes.length) return;
  const marks = scopes.map(() => "?").join(",");
  const ids = (db.prepare(`SELECT entry_id FROM entries WHERE scope_id IN (${marks})`).all(...scopes) as { entry_id: string }[]).map((row) => row.entry_id);
  const indexed = db.prepare(`SELECT rowid, title, body, tags FROM entries WHERE scope_id IN (${marks})`).all(...scopes) as { rowid: number; title: string; body: string; tags: string }[];
  db.transaction(() => {
    const deleteFts = db.prepare("INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', ?, ?, ?, ?)");
    for (const row of indexed) deleteFts.run(row.rowid, row.title, row.body, (JSON.parse(row.tags) as string[]).join(" "));
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
    private readonly purgeReplay?: (db: Database.Database, entryId: string) => void,
  ) {}

  seal(poolId: string, nodeId: string): string {
    const pool = this.main.prepare("SELECT storage FROM pools WHERE pool_id = ?").get(poolId) as { storage: string } | undefined;
    if (!pool) throw new Error(`pool not found: ${poolId}`);
    if (pool.storage === "sealed") throw new Error("pool is already sealed");
    const relative = `sealed/${poolId}.db`;
    const key = this.keys.create(poolId);
    const sealed = this.databases.open(`${this.dataDir}/${relative}`, key, true);
    registerOriginSequenceCoordinator(sealed, this.main);
    const scopes = scopeIds(this.main, poolId);
    copyRoutingMetadata(this.main, sealed);
    transferContent(this.main, sealed, scopes);
    copyAccessMetadata(this.main, sealed);
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
    registerOriginSequenceCoordinator(sealed, this.main);
    this.openPools.set(poolId, { db: sealed, expiresAt: Date.now() + this.unlockMinutes * 60_000 });
    if (this.purgeReplay) this.replayQueuedPurges(poolId, this.purgeReplay);
  }

  lock(poolId: string): void {
    let opened = this.openPools.get(poolId);
    if (!opened) {
      const pool = this.main.prepare("SELECT sealed_file FROM pools WHERE pool_id = ? AND storage = 'sealed'").get(poolId) as { sealed_file: string } | undefined;
      if (!pool?.sealed_file) return;
      opened = { db: this.databases.open(`${this.dataDir}/${pool.sealed_file}`, this.keys.get(poolId), false), expiresAt: 0 };
      registerOriginSequenceCoordinator(opened.db, this.main);
    }
    opened.db.close();
    this.openPools.delete(poolId);
  }

  lockExpired(now = Date.now()): string[] {
    const locked: string[] = [];
    for (const [poolId, state] of this.openPools) if (state.expiresAt <= now) { this.lock(poolId); locked.push(poolId); }
    return locked;
  }

  /**
   * W2: installs a key this node received through an authenticated transfer
   * (src/sealed/keyTransfer.ts's completeKeyTransfer) and records the enrollment, so the next
   * sync pull starts receiving this pool's sealed events (servePull's own `pool_enrollments`
   * check) and a later `unlock` finds the key. The sealed database file itself is not written
   * here: it arrives through that same normal event sync, not through key transfer.
   */
  enroll(poolId: string, nodeId: string, key: Buffer): void {
    const pool = this.main.prepare("SELECT storage FROM pools WHERE pool_id = ?").get(poolId) as { storage: string } | undefined;
    if (!pool || pool.storage !== "sealed") throw new Error(`pool not found or not sealed: ${poolId}`);
    this.keys.store(poolId, key);
    this.main.prepare("INSERT INTO pool_enrollments (pool_id, node_id, enrolled_at) VALUES (?, ?, ?) ON CONFLICT (pool_id, node_id) DO NOTHING").run(poolId, nodeId, new Date().toISOString());
  }

  /** Where a rekey's new key is parked between generating it and committing it, so a crash in the one irreversible step is recoverable rather than fatal. */
  static stagingKeyId(poolId: string): string {
    return `${poolId}.rekey-pending`;
  }

  /**
   * Rotate a sealed pool's key (W7's approved follow-up to W2). Generates a fresh 32-byte key,
   * re-encrypts the pool's own database file under it, and reports which *other* nodes were
   * holding the old key, so the caller can emit one `pool_unenroll` acl event each: their copies
   * of the key stop being useful for anything new, and they have to re-enroll through W2's
   * authenticated transfer to get the new one. Deleting those rows is deliberately not done here,
   * since materialized access state only ever changes through an event (ADR 0002).
   *
   * Step order is the whole design, because exactly one step cannot be undone:
   *
   *   1. stage the new key under `stagingKeyId(poolId)`;
   *   2. re-encrypt the file (**irreversible**);
   *   3. promote the new key to `poolId`;
   *   4. drop the staging copy.
   *
   * A crash between 2 and 3 leaves a file on the new key while `poolId` still holds the old one,
   * so the pool will not unlock; the staging entry is the recovery path, and the thrown error
   * names it rather than leaving the owner to guess. Staging before step 2 (rather than after) is
   * what makes that window recoverable at all.
   *
   * What this deliberately does not do: re-wrap the new key for the remaining enrolled nodes.
   * That needs each one's prekey and the owner's approval per node, which is exactly W2's
   * transfer flow; doing it silently here would hand out a pool key without the confirmation
   * step W2 exists to provide.
   */
  rekey(poolId: string, selfNodeId: string): string[] {
    const pool = this.main.prepare("SELECT sealed_file FROM pools WHERE pool_id = ? AND storage = 'sealed'").get(poolId) as { sealed_file: string } | undefined;
    if (!pool?.sealed_file) throw new Error(`pool not found or not sealed: ${poolId}`);

    const current = this.keys.get(poolId); // throws if this node has no key for the pool
    const next = randomBytes(32);
    const staging = SealedPoolStore.stagingKeyId(poolId);
    this.keys.store(staging, next);

    if (this.isUnlocked(poolId)) this.lock(poolId); // re-encrypt a quiesced file, never an open handle
    const sealed = this.databases.open(`${this.dataDir}/${pool.sealed_file}`, current, false);
    try {
      this.databases.rekey(sealed, next);
    } catch (err) {
      this.keys.remove(staging); // step 2 never happened, so the old key is still the right one
      throw err;
    } finally {
      sealed.close();
    }

    try {
      this.keys.store(poolId, next);
      this.keys.remove(staging);
    } catch (err) {
      throw new Error(
        `sealed pool ${poolId} was re-encrypted but its new key could not be committed (${err instanceof Error ? err.message : String(err)}); the new key is still stored as "${staging}" and the pool will not unlock until it is promoted to "${poolId}"`,
      );
    }

    return (this.main.prepare("SELECT node_id FROM pool_enrollments WHERE pool_id = ? AND node_id <> ? ORDER BY node_id").all(poolId, selfNodeId) as { node_id: string }[]).map(
      (row) => row.node_id,
    );
  }

  /**
   * Route one request to an unlocked sealed database. The callback must not retain the handle.
   * Plaintext rows never enter the main database during the unlock window.
   */
  withPool<T>(poolId: string, request: (db: Database.Database) => T): T {
    this.unlock(poolId);
    const opened = this.openPools.get(poolId);
    if (!opened) throw new Error("sealed pool failed to unlock");
    opened.expiresAt = Date.now() + this.unlockMinutes * 60_000;
    copyRoutingMetadata(this.main, opened.db);
    copyAccessMetadata(this.main, opened.db);
    return request(opened.db);
  }

  /** Resolve a scope to its sealed store, or use the ordinary database for an unsealed scope. */
  forScope<T>(scopeId: string, request: (db: Database.Database) => T): T {
    const sealed = this.main.prepare(
      `SELECT p.pool_id FROM pool_grants pg JOIN pools p ON p.pool_id = pg.pool_id
       WHERE pg.scope_id = ? AND p.storage = 'sealed' LIMIT 1`,
    ).get(scopeId) as { pool_id: string } | undefined;
    return sealed ? this.withPool(sealed.pool_id, request) : request(this.main);
  }

  /** Queue a purge without opening the encrypted file. It is replayed on the next routed request. */
  queuePurge(poolId: string, entryId: string): void {
    this.main.prepare(
      "INSERT OR IGNORE INTO sealed_purge_queue (pool_id, entry_id, requested_at) VALUES (?, ?, ?)",
    ).run(poolId, entryId, new Date().toISOString());
  }

  /**
   * Replay queued purges inside the encrypted store. A queue row is removed only after its
   * callback succeeds, so a crash or rejected purge remains retryable.
   */
  replayQueuedPurges(poolId: string, purge: (db: Database.Database, entryId: string) => void): number {
    return this.withPool(poolId, (db) => {
      const queued = this.main.prepare(
        "SELECT entry_id FROM sealed_purge_queue WHERE pool_id = ? ORDER BY requested_at, entry_id",
      ).all(poolId) as { entry_id: string }[];
      let replayed = 0;
      for (const row of queued) {
        purge(db, row.entry_id);
        this.main.prepare("DELETE FROM sealed_purge_queue WHERE pool_id = ? AND entry_id = ?").run(poolId, row.entry_id);
        replayed++;
      }
      return replayed;
    });
  }

  isUnlocked(poolId: string): boolean { return this.openPools.has(poolId); }
  close(): void { for (const poolId of [...this.openPools.keys()]) this.lock(poolId); }
}
