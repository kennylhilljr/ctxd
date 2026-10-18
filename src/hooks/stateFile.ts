/**
 * Hook state file I/O (SPEC v6 section 9.8): small per-session JSON files, written atomically
 * under a per-file lock so concurrent hooks (e.g. async PostToolUse and Stop) never tear a write.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_WAIT_MS = 200;
const LOCK_POLL_MS = 10;
const LOCK_STALE_MS = 5000;

function lockPath(path: string): string {
  return `${path}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Try once to take the lock, breaking a stale one (older than 5s) first. */
function tryLockOnce(path: string): boolean {
  const lock = lockPath(path);
  try {
    const fd = openSync(lock, "wx"); // exclusive create; throws EEXIST if already locked
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lock);
        return tryLockOnce(path);
      }
    } catch {
      // lock vanished between the stat and the unlink, or the unlink lost a race: fine, retry on the next poll
    }
    return false;
  }
}

function unlock(path: string): void {
  try {
    unlinkSync(lockPath(path));
  } catch {
    // already gone
  }
}

/** Read a small JSON state file, or undefined if it doesn't exist or isn't valid JSON. Never throws. */
export function readStateFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Write a small JSON state file under a per-file lock, atomically (temp file, fsync, rename).
 * Lock waits are bounded to 200ms (polling every 10ms); on contention, the write is skipped
 * (returns false) rather than blocking -- a missed nudge or checkpoint is acceptable, a blocked
 * or broken session is not.
 */
export async function writeStateFileLocked<T>(path: string, value: T): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryLockOnce(path)) {
    if (Date.now() >= deadline) return false;
    await sleep(LOCK_POLL_MS);
  }
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    return true;
  } finally {
    unlock(path);
  }
}
