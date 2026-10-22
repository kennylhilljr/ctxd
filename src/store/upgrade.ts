import Database from "better-sqlite3";
import { openDatabase } from "./db.js";
import { rebuild } from "./rebuild.js";
import { SCHEMA_VERSION } from "./schema.js";

/**
 * Recover a database the migration chain cannot reach, by rebuilding it from its own event log
 * instead of altering it in place.
 *
 * `migrateSchema` (src/store/db.ts) starts at version 13, so an install created before that is
 * refused outright and every command fails, including `ctxd doctor` and `ctxd rebuild`, which are
 * the two the error message used to suggest. Writing the missing 1-to-12 steps would mean several
 * SQLite table rebuilds (versions 7 and 8 alone drop a column and change an `events.op` CHECK
 * constraint), each run against what may be the only copy of real data. This takes the safer road
 * the architecture already implies: the event log is the source of truth (ADR 0002), so a fresh
 * database at the current schema plus a replay reproduces the content, and only the facts that are
 * *not* event-sourced need carrying across.
 *
 * The source file is opened read-only and never written. The result is a new file, so the owner
 * swaps it in deliberately and keeps the original as its own backup.
 */

/**
 * Tables carried before the replay: identity, configuration and local-only operational facts, none
 * of which `rebuild` reconstructs. `events` is here too, since it is what the replay reads.
 * Absent tables and dropped columns are handled by the column intersection, so this list can name
 * tables a given old version never had.
 */
const CARRY_BEFORE_REBUILD = [
  "nodes",
  "node_keys",
  "node_origin_sequences",
  "node_encryption_keys",
  "clients",
  "persona_tokens",
  "persona_prefs",
  "scopes",
  "scope_repos",
  "peers",
  "peer_watermarks",
  "sync_state",
  "pool_enrollments",
  "sealed_purge_queue",
  "sealed_key_transfers",
  "sessions",
  "read_stats",
  "tool_metrics",
  "rejections",
  "access_requests",
  "commits",
  "skill_syncs",
  "mirror_files",
  "mirror_conflicts",
  "archive_requests",
  "embeddings",
  "batches",
  "batch_entries",
  "entry_siblings",
  "events",
] as const;

/**
 * `rebuild` deletes these to reconstruct them from `acl` events, so carrying them before the replay
 * would silently throw them away: a pre-acl database has no such events, and its pool, grants and
 * members would simply vanish. They are restored afterwards instead, and only when the source has
 * no `acl` events at all; when it has some, the replay is authoritative and re-inserting old rows
 * could resurrect access a later revoke had removed.
 *
 * `acl_cursors` is deliberately absent: it is an HLC guard, and carrying a stale cursor would make
 * every later `acl` event a no-op, a bug `ctxd rebuild` already had once.
 */
const CARRY_AFTER_REBUILD = ["pools", "pool_grants", "pool_members", "client_grants"] as const;

export interface CarriedTable {
  table: string;
  rows: number;
  droppedColumns: string[];
}

export interface UpgradeReport {
  fromVersion: number;
  toVersion: number;
  carried: CarriedTable[];
  entries: number;
  relations: number;
  /** Rows restored after the replay, or null when the source had `acl` events and the replay was left authoritative. */
  aclRowsRestored: number | null;
}

function columnsOf(db: Database.Database, table: string): string[] {
  try {
    return (db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name);
  } catch {
    return [];
  }
}

/** Copies one table by the intersection of its old and new columns, so a removed or renamed column is reported rather than failing the whole upgrade. */
function carry(source: Database.Database, target: Database.Database, table: string, mode: "replace" | "ignore"): CarriedTable | null {
  const oldColumns = columnsOf(source, table);
  const shared = oldColumns.filter((c) => columnsOf(target, table).includes(c));
  if (shared.length === 0) return null;
  const quoted = shared.map((c) => `"${c}"`).join(",");
  const rows = source.prepare(`SELECT ${quoted} FROM "${table}"`).all() as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const verb = mode === "replace" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  const insert = target.prepare(`${verb} INTO "${table}" (${quoted}) VALUES (${shared.map(() => "?").join(",")})`);
  let written = 0;
  target.transaction(() => {
    for (const row of rows) written += insert.run(...shared.map((c) => row[c])).changes;
  })();
  return { table, rows: written, droppedColumns: oldColumns.filter((c) => !shared.includes(c)) };
}

export function upgradeDatabase(sourcePath: string, targetPath: string): UpgradeReport {
  const source = new Database(sourcePath, { readonly: true });
  const fromVersion = source.pragma("user_version", { simple: true }) as number;
  const target = openDatabase(targetPath, { create: true });
  try {
    const carried: CarriedTable[] = [];
    for (const table of CARRY_BEFORE_REBUILD) {
      const result = carry(source, target, table, "replace");
      if (result) carried.push(result);
    }

    rebuild(target);

    const sourceAclEvents = (source.prepare("SELECT COUNT(*) AS n FROM events WHERE op = 'acl'").get() as { n: number }).n;
    let aclRowsRestored: number | null = null;
    if (sourceAclEvents === 0) {
      aclRowsRestored = 0;
      for (const table of CARRY_AFTER_REBUILD) {
        const result = carry(source, target, table, "ignore");
        if (result) {
          carried.push(result);
          aclRowsRestored += result.rows;
        }
      }
    }

    return {
      fromVersion,
      toVersion: target.pragma("user_version", { simple: true }) as number,
      carried,
      entries: (target.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n,
      relations: (target.prepare("SELECT COUNT(*) AS n FROM relations").get() as { n: number }).n,
      aclRowsRestored,
    };
  } finally {
    source.close();
    target.close();
  }
}

/** Whether a database at this version needs `ctxd upgrade` rather than the ordinary migration chain. */
export function needsUpgrade(version: number): boolean {
  return version > 0 && version < 13 && SCHEMA_VERSION >= 13;
}
