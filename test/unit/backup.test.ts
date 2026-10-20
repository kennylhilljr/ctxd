import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";
import { backupFilename, backupsDir, runBackup, runRestore } from "../../src/cli/backup.js";

/**
 * `ctxd backup` / `ctxd restore` (SPEC v8 section 12, M4 slice 3). This environment has no real
 * `age` binary installed, and age's own encryption correctness is not ctxd's to test; these
 * tests put a fake `age` stand-in first on PATH that copies its input to its output, ignoring
 * `-r`/`-i`/`--decrypt`, so every test here exercises ctxd's own orchestration (VACUUM INTO,
 * pruning, copy_to, the force-refusal and backup-before-overwrite in restore) rather than age's.
 */

const ORIGINAL_PATH = process.env.PATH;
let fakeAgeDir: string;

beforeEach(() => {
  fakeAgeDir = mkdtempSync(join(tmpdir(), "ctxd-fake-age-"));
  const agePath = join(fakeAgeDir, "age");
  writeFileSync(
    agePath,
    `#!/bin/sh
set -e
dest=""
src=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2;;
    -r) shift 2;;
    -i) shift 2;;
    --decrypt) shift;;
    *) src="$1"; shift;;
  esac
done
cp "$src" "$dest"
`,
  );
  chmodSync(agePath, 0o755);
  process.env.PATH = `${fakeAgeDir}:${ORIGINAL_PATH}`;
});

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
});

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "ctxd-backup-"));
}

function realDbPath(dataDir: string): string {
  const path = join(dataDir, "ctxd.db");
  openDatabase(path, { create: true }).close();
  return path;
}

describe("backupFilename", () => {
  it("replaces colons and dots so the name is filesystem-safe, and sorts chronologically", () => {
    const a = backupFilename(new Date("2026-01-01T00:00:00.000Z"));
    const b = backupFilename(new Date("2026-01-02T00:00:00.000Z"));
    expect(a).toBe("ctxd-2026-01-01T00-00-00-000Z.db.age");
    expect(a < b).toBe(true);
  });
});

describe("runBackup", () => {
  it("refuses with no age recipient configured", () => {
    const dataDir = tmpDataDir();
    const db = openDatabase(realDbPath(dataDir));
    expect(() => runBackup(db, { dataDir, ageRecipient: "" })).toThrow(/age_recipient/);
    db.close();
  });

  it("writes an encrypted backup file into backups/", () => {
    const dataDir = tmpDataDir();
    const db = openDatabase(realDbPath(dataDir));
    const result = runBackup(db, { dataDir, ageRecipient: "age1testrecipient" });
    expect(existsSync(result.path)).toBe(true);
    expect(result.path.startsWith(backupsDir(dataDir))).toBe(true);
    expect(result.pruned).toEqual([]);
    db.close();
  });

  it("prunes down to the newest `keep` backups", () => {
    const dataDir = tmpDataDir();
    const dir = backupsDir(dataDir);
    mkdirSync(dir, { recursive: true });
    for (const day of [1, 2, 3]) {
      writeFileSync(join(dir, backupFilename(new Date(`2026-01-0${day}T00:00:00.000Z`))), "stale");
    }
    const db = openDatabase(realDbPath(dataDir));
    const result = runBackup(db, { dataDir, ageRecipient: "age1testrecipient", keep: 2, now: new Date("2026-01-04T00:00:00.000Z") });
    db.close();

    expect(result.pruned).toHaveLength(2);
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".db.age"));
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain(backupFilename(new Date("2026-01-03T00:00:00.000Z")));
    expect(remaining).toContain(backupFilename(new Date("2026-01-04T00:00:00.000Z")));
  });

  it("copies the backup to copyTo when given", () => {
    const dataDir = tmpDataDir();
    const copyTo = mkdtempSync(join(tmpdir(), "ctxd-backup-copy-"));
    const db = openDatabase(realDbPath(dataDir));
    const result = runBackup(db, { dataDir, ageRecipient: "age1testrecipient", copyTo });
    db.close();
    expect(result.copiedTo).toBeDefined();
    expect(existsSync(result.copiedTo!)).toBe(true);
  });

  it("backs up sealed database files as ciphertext companions without adding them to the main database", () => {
    const dataDir = tmpDataDir();
    const sealedDir = join(dataDir, "sealed");
    mkdirSync(sealedDir, { recursive: true });
    const ciphertext = Buffer.from("sqlcipher ciphertext fixture");
    writeFileSync(join(sealedDir, "pool-id.db"), ciphertext);
    const db = openDatabase(realDbPath(dataDir));
    const result = runBackup(db, { dataDir, ageRecipient: "age1testrecipient" });
    db.close();
    expect(result.sealedPaths).toHaveLength(1);
    expect(readFileSync(result.sealedPaths[0]!)).toEqual(ciphertext);
    const main = openDatabase(result.path);
    expect(main.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
    main.close();
  });
});

describe("runRestore", () => {
  it("round-trips a backup made by runBackup", () => {
    const sourceDir = tmpDataDir();
    const db = openDatabase(realDbPath(sourceDir));
    const backup = runBackup(db, { dataDir: sourceDir, ageRecipient: "age1testrecipient" });
    db.close();

    const targetDir = tmpDataDir();
    const result = runRestore({ file: backup.path, identity: "unused-by-the-fake-age", dataDir: targetDir });
    expect(result.restoredTo).toBe(join(targetDir, "ctxd.db"));
    expect(result.replacedBackupPath).toBeUndefined();
    const restored = openDatabase(result.restoredTo);
    restored.close();
  });

  it("restores sealed ciphertext companions beside the main database", () => {
    const sourceDir = tmpDataDir();
    mkdirSync(join(sourceDir, "sealed"), { recursive: true });
    const ciphertext = Buffer.from("encrypted sealed database bytes");
    writeFileSync(join(sourceDir, "sealed", "pool-id.db"), ciphertext);
    const db = openDatabase(realDbPath(sourceDir));
    const backup = runBackup(db, { dataDir: sourceDir, ageRecipient: "age1testrecipient" });
    db.close();

    const targetDir = tmpDataDir();
    const result = runRestore({ file: backup.path, identity: "unused", dataDir: targetDir });
    expect(result.sealedRestored).toEqual([join(targetDir, "sealed", "pool-id.db")]);
    expect(readFileSync(result.sealedRestored[0]!)).toEqual(ciphertext);
  });

  it("refuses to overwrite a healthy existing database without --force", () => {
    const sourceDir = tmpDataDir();
    const db = openDatabase(realDbPath(sourceDir));
    const backup = runBackup(db, { dataDir: sourceDir, ageRecipient: "age1testrecipient" });
    db.close();

    const targetDir = tmpDataDir();
    realDbPath(targetDir); // a healthy database already lives here
    expect(() => runRestore({ file: backup.path, identity: "unused", dataDir: targetDir })).toThrow(/refusing to overwrite/);
  });

  it("overwrites with --force, backing up the file it replaces", () => {
    const sourceDir = tmpDataDir();
    const db = openDatabase(realDbPath(sourceDir));
    const backup = runBackup(db, { dataDir: sourceDir, ageRecipient: "age1testrecipient" });
    db.close();

    const targetDir = tmpDataDir();
    realDbPath(targetDir);
    const result = runRestore({ file: backup.path, identity: "unused", dataDir: targetDir, force: true });
    expect(result.replacedBackupPath).toBeDefined();
    expect(existsSync(result.replacedBackupPath!)).toBe(true);
  });

  it("rejects a restored file that fails its integrity check, and installs nothing", () => {
    const sourceDir = tmpDataDir();
    const garbage = join(sourceDir, "garbage.db.age");
    writeFileSync(garbage, "not a database at all");

    const targetDir = tmpDataDir();
    expect(() => runRestore({ file: garbage, identity: "unused", dataDir: targetDir })).toThrow(/integrity check/);
    expect(existsSync(join(targetDir, "ctxd.db"))).toBe(false);
  });
});
