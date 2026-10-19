/**
 * `ctxd backup` / `ctxd restore <file>` (SPEC v8 section 12, PRD-trust-safety-v4 section 8, TS-10
 * and TS-11, PRD-v7 M4): `VACUUM INTO` a temporary file, `age`-encrypt it into `backups/`, prune
 * to the newest 14, then an optional plain-file copy to `[backup] copy_to` (a local path, such as
 * a Google Drive desktop-sync folder, so a plain copy is already ciphertext by the time it
 * leaves the machine). `age`'s own encryption is never reimplemented here: ctxd only ever shells
 * out to the `age` binary with the configured recipient (encrypt) or a caller-supplied identity
 * file (decrypt) and never holds the private key itself (SPEC: "Recipient key per user").
 *
 * `ctxd restore` refuses to overwrite a database that still passes its own integrity check
 * (checkDatabaseIntegrity, M4 slice 1) unless `--force` is given, and even then backs up the file
 * it replaces, matching `install-hooks`' own "back up the original first" rule.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir } from "./common.js";
import { loadConfig } from "../config/config.js";
import { resolveFlags, requireFlag, isFlagOn } from "../config/flags.js";
import { checkDatabaseIntegrity, openDatabase } from "../store/db.js";

const KEEP = 14;
const BACKUP_SUFFIX = ".db.age";

export function backupsDir(dataDir: string): string {
  return join(dataDir, "backups");
}

/** `ctxd-2026-10-19T14-30-00-000Z.db.age`: colons and dots replaced so the name is filesystem-safe everywhere, and still sorts chronologically. */
export function backupFilename(date: Date): string {
  return `ctxd-${date.toISOString().replace(/[:.]/g, "-")}${BACKUP_SUFFIX}`;
}

export interface BackupOptions {
  dataDir: string;
  ageRecipient: string;
  copyTo?: string;
  keep?: number;
  now?: Date;
}

export interface BackupResult {
  path: string;
  copiedTo?: string;
  pruned: string[];
}

/** Deletes everything but the `keep` most recent `*.db.age` files in `dir`; returns what it removed. */
function pruneBackups(dir: string, keep: number): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(BACKUP_SUFFIX))
    .sort();
  const excess = files.length - keep;
  if (excess <= 0) return [];
  const removed = files.slice(0, excess);
  for (const f of removed) unlinkSync(join(dir, f));
  return removed;
}

export function runBackup(db: Database.Database, opts: BackupOptions): BackupResult {
  if (!opts.ageRecipient) {
    throw new Error(
      'No backup recipient configured. Set [backup] age_recipient in config.toml (your "age" public key) before running "ctxd backup".',
    );
  }
  const dir = backupsDir(opts.dataDir);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${randomBytes(6).toString("hex")}.db`);
  const destPath = join(dir, backupFilename(opts.now ?? new Date()));
  db.prepare("VACUUM INTO ?").run(tmpPath);
  try {
    execFileSync("age", ["-r", opts.ageRecipient, "-o", destPath, tmpPath]);
  } finally {
    rmSync(tmpPath, { force: true });
  }

  const pruned = pruneBackups(dir, opts.keep ?? KEEP);

  let copiedTo: string | undefined;
  if (opts.copyTo) {
    mkdirSync(opts.copyTo, { recursive: true });
    copiedTo = join(opts.copyTo, basename(destPath));
    copyFileSync(destPath, copiedTo);
  }
  return { path: destPath, copiedTo, pruned };
}

export interface RestoreOptions {
  file: string;
  identity: string;
  dataDir: string;
  force?: boolean;
}

export interface RestoreResult {
  restoredTo: string;
  replacedBackupPath?: string;
}

function existingDatabaseIsHealthy(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  try {
    const db = openDatabase(dbPath);
    const integrity = checkDatabaseIntegrity(db);
    db.close();
    return integrity.ok;
  } catch {
    return false;
  }
}

export function runRestore(opts: RestoreOptions): RestoreResult {
  const dbPath = join(opts.dataDir, "ctxd.db");
  if (!opts.force && existingDatabaseIsHealthy(dbPath)) {
    throw new Error(`${dbPath} already exists and passes its integrity check; refusing to overwrite it. Pass --force to restore anyway (the existing file is backed up first).`);
  }

  mkdirSync(opts.dataDir, { recursive: true });
  const tmpPath = join(opts.dataDir, `.restore-${randomBytes(6).toString("hex")}.db`);
  execFileSync("age", ["--decrypt", "-i", opts.identity, "-o", tmpPath, opts.file]);

  // Severe corruption can make openDatabase itself throw (SQLite's own "file is not a database")
  // before checkDatabaseIntegrity's quick_check ever runs; either layer means the same thing here.
  let integrityReason: string;
  try {
    const restored = openDatabase(tmpPath);
    const integrity = checkDatabaseIntegrity(restored);
    restored.close();
    integrityReason = integrity.ok ? "" : integrity.reason!;
  } catch (err) {
    integrityReason = err instanceof Error ? err.message : String(err);
  }
  if (integrityReason) {
    rmSync(tmpPath, { force: true });
    throw new Error(`Restored database failed its integrity check (${integrityReason}); not installed.`);
  }

  let replacedBackupPath: string | undefined;
  if (existsSync(dbPath)) {
    replacedBackupPath = `${dbPath}.bak-${Date.now()}`;
    renameSync(dbPath, replacedBackupPath);
  }
  renameSync(tmpPath, dbPath);
  return { restoredTo: dbPath, replacedBackupPath };
}

function usage(): string {
  return ["Usage: ctxd backup [--copy-to <path>]", "       ctxd restore <file> --identity <path> [--force]"].join("\n");
}

export function runBackupCommand(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { "copy-to": { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const configPath = resolveConfigPath({ configPath: values.config });
  const config = loadConfig(configPath);
  const flags = resolveFlags(config);
  try {
    requireFlag(flags, "backups");
  } catch (err) {
    console.error(`ctxd backup: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const copyTo = isFlagOn(flags, "backups.copy") ? values["copy-to"] ?? (config.backup.copy_to || undefined) : undefined;
    const result = runBackup(db, { dataDir, ageRecipient: config.backup.age_recipient, copyTo });
    console.log(`ctxd backup: wrote ${result.path}${result.copiedTo ? `, copied to ${result.copiedTo}` : ""}.`);
    if (result.pruned.length > 0) console.log(`ctxd backup: pruned ${result.pruned.length} older backup(s).`);
    return 0;
  } catch (err) {
    console.error(`ctxd backup: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}

export function runRestoreCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { identity: { type: "string" }, force: { type: "boolean" }, "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const file = positionals[0];
  if (!file || !values.identity) {
    console.error(usage());
    return 1;
  }
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  try {
    const result = runRestore({ file, identity: values.identity, dataDir, force: values.force });
    console.log(`ctxd restore: restored to ${result.restoredTo}.`);
    if (result.replacedBackupPath) console.log(`ctxd restore: the file it replaced is at ${result.replacedBackupPath}.`);
    return 0;
  } catch (err) {
    console.error(`ctxd restore: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
