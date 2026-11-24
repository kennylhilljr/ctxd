import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { deleteSecret, readSecret, storeSecret, type KeychainOptions } from "../access/keychain.js";
import { newId } from "../core/ids.js";

/**
 * The token this node presents when pulling from a peer lives only in the macOS Keychain, the
 * same place persona token secrets live (SPEC v6 8.4). `peers.outgoing_token` holds a reference
 * (`keychain:<account>`), never the raw token, so the database file and every backup or export of
 * it carry no working peer credential. A restored database on another machine has the reference
 * but not the secret; pulling from that peer then fails until `ctxd node add-peer --token` runs.
 */

const SERVICE = "ctxd";
const REF_PREFIX = "keychain:";

/** True when the stored column value is a keychain reference rather than a legacy raw token. */
export function isKeychainRef(stored: string): boolean {
  return stored.startsWith(REF_PREFIX);
}

/**
 * Stores the raw token under a fresh keychain account and returns its reference. Every write gets
 * its own account, so a reference already in the database keeps pointing at an intact secret until
 * the caller has committed the new one (see `commitPeerOutgoingToken`).
 */
export function storePeerOutgoingToken(peerId: string, token: string, opts: KeychainOptions = {}): string {
  const account = `peer-outgoing/${peerId}/${newId()}`;
  storeSecret(SERVICE, account, token, opts);
  return `${REF_PREFIX}${account}`;
}

/**
 * Stores `token` in the keychain, then runs `commit` with its reference to write it to the database.
 * If `commit` throws or returns false (nothing was written), the new secret is deleted again; if it
 * succeeds, the secret `previous` pointed to is deleted. Returns whether the commit happened.
 */
export function commitPeerOutgoingToken(peerId: string, token: string, previous: string | null, commit: (ref: string) => boolean, opts: KeychainOptions = {}): boolean {
  const ref = storePeerOutgoingToken(peerId, token, opts);
  let committed = false;
  try {
    committed = commit(ref);
  } finally {
    deletePeerOutgoingToken(committed ? previous : ref, opts);
  }
  return committed;
}

/**
 * Resolves `peers.outgoing_token` to the raw token, or null when there is none (never supplied,
 * or the keychain no longer has it). A legacy raw value is returned as is: it exists only until
 * `migratePeerOutgoingTokens` moves it, which also happens when that move failed.
 */
export function readPeerOutgoingToken(stored: string | null, opts: KeychainOptions = {}): string | null {
  if (!stored) return null;
  if (!isKeychainRef(stored)) return stored;
  return readSecret(SERVICE, stored.slice(REF_PREFIX.length), opts);
}

/** Deletes the keychain secret a stored reference points to; a legacy raw value has none. */
export function deletePeerOutgoingToken(stored: string | null, opts: KeychainOptions = {}): void {
  if (stored && isKeychainRef(stored)) deleteSecret(SERVICE, stored.slice(REF_PREFIX.length), opts);
}

export interface PeerTokenMigration {
  migrated: number;
  failed: string[];
  /** A reader blocked the WAL checkpoint; SQLite's next automatic checkpoint overwrites the old pages. */
  checkpointBusy?: boolean;
}

/**
 * Moves every raw `outgoing_token` left by an earlier version into the keychain and replaces it
 * with a reference. Idempotent. A peer whose keychain write fails keeps its raw value (sync keeps
 * working) and is reported, so the next run retries it; one failure never stops the others.
 */
export function migratePeerOutgoingTokens(db: Database.Database, opts: KeychainOptions = {}): PeerTokenMigration {
  const rows = db
    .prepare(`SELECT peer_id, name, outgoing_token FROM peers WHERE outgoing_token IS NOT NULL AND outgoing_token NOT LIKE '${REF_PREFIX}%'`)
    .all() as { peer_id: string; name: string; outgoing_token: string }[];
  const update = db.prepare("UPDATE peers SET outgoing_token = ? WHERE peer_id = ? AND outgoing_token = ?");
  const result: PeerTokenMigration = { migrated: 0, failed: [] };
  if (rows.length === 0) return result;
  // secure_delete zeroes the replaced bytes, so the raw token does not linger in free page space.
  const secureDelete = db.pragma("secure_delete", { simple: true }) as number;
  db.pragma("secure_delete = ON");
  try {
    for (const row of rows) {
      try {
        // The conditional update changes nothing if the row was rotated meanwhile; the new secret is then dropped.
        const moved = commitPeerOutgoingToken(row.peer_id, row.outgoing_token, null, (ref) => update.run(ref, row.peer_id, row.outgoing_token).changes === 1, opts);
        if (moved) result.migrated++;
      } catch {
        result.failed.push(row.name);
      }
    }
  } finally {
    db.pragma(`secure_delete = ${secureDelete}`);
  }
  // Flush the rewritten pages into the main file and empty the WAL, so neither keeps the old bytes.
  // A reader can block it (busy): the new page images are already zeroed by secure_delete, and the
  // next checkpoint SQLite runs (automatically, or when the last connection closes) copies them over
  // the old pages. Reported so the caller can say so.
  if (result.migrated > 0) {
    const [status] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (status?.busy) result.checkpointBusy = true;
  }
  return result;
}

/** Clears every raw (unmigrated) outgoing token, zeroing its bytes. For a copy such as a backup image, never the live database. */
export function redactRawPeerOutgoingTokens(db: Database.Database): number {
  db.pragma("secure_delete = ON");
  return db.prepare(`UPDATE peers SET outgoing_token = NULL WHERE outgoing_token NOT LIKE '${REF_PREFIX}%'`).run().changes;
}

/**
 * Runs the migration (and, given the data directory, the pending-transfer scrub) and reports a
 * failure on stderr without ever throwing, for command and server startup.
 */
export function migratePeerOutgoingTokensQuietly(db: Database.Database, prefix: string, dataDir?: string, opts: KeychainOptions = {}): void {
  try {
    const { failed, checkpointBusy } = migratePeerOutgoingTokens(db, opts);
    if (checkpointBusy) {
      console.error(`${prefix}: outgoing peer tokens moved to the keychain; the database file is cleaned at SQLite's next checkpoint (another process held it open).`);
    }
    if (failed.length > 0) {
      console.error(`${prefix}: could not move the outgoing token for peer(s) ${failed.join(", ")} into the keychain; it stays in the database until a later run succeeds.`);
    }
  } catch (err) {
    console.error(`${prefix}: outgoing peer token migration skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (dataDir) {
    const { failed } = scrubPendingTransferTokens(dataDir);
    if (failed.length > 0) {
      console.error(`${prefix}: could not remove the outgoing token from pending key-transfer state file(s) ${failed.join(", ")}; delete them by hand if the transfer is abandoned.`);
    }
  }
}

/**
 * Earlier versions also copied the raw outgoing token into each pending enrollment state file
 * (`key-transfers/<transferId>.json`). Rewrites any such file without it; completion re-reads the
 * token from the keychain. Never throws: a file it cannot read or rewrite is listed in `failed`.
 */
export function scrubPendingTransferTokens(dataDir: string): { scrubbed: number; failed: string[] } {
  const result = { scrubbed: 0, failed: [] as string[] };
  const dir = join(dataDir, "key-transfers");
  let files: string[];
  try {
    files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  } catch {
    result.failed.push(dir);
    return result;
  }
  for (const file of files) {
    const path = join(dir, file);
    try {
      const raw = readFileSync(path, "utf8");
      if (!raw.includes("outgoingToken")) continue;
      const state = JSON.parse(raw) as Record<string, unknown>;
      if (!("outgoingToken" in state)) continue;
      delete state.outgoingToken;
      writeFileSync(path, JSON.stringify(state));
      result.scrubbed++;
    } catch {
      result.failed.push(file);
    }
  }
  return result;
}
