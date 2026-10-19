import type Database from "better-sqlite3";
import { intentOverlaps, type OverlapPair } from "./intent.js";

/**
 * Scans `leases` for other active, non-suspended claims in the same scope whose write intent
 * overlaps `paths` (SPEC 7.5.2). Shared by a local claim's synchronous overlap check
 * (src/store/claim.ts, returned straight to the caller) and a replicated claim's persisted
 * `claim_overlaps` rows (src/store/materialize.ts, Spec 7.4, M3 slice 5), so the two paths can
 * never disagree about what counts as an overlap. Lives outside claims/intent.ts, which is pure
 * functions only, and outside store/claim.ts, which store/materialize.ts cannot import without a
 * cycle (claim.ts already imports materialize.ts's `applyEvent`).
 */

export interface LeaseOverlap {
  taskId: string;
  holder: string;
  pairs: OverlapPair[];
}

export interface OverlapScan {
  overlaps: LeaseOverlap[];
  /** Other active leases whose intent couldn't be compared because either side's paths are unknown (NULL), not reported as an overlap (SPEC 7.5.2). */
  intentUnknown: string[];
}

export function scanOverlappingLeases(db: Database.Database, scopeId: string, taskId: string, paths: readonly string[] | undefined): OverlapScan {
  const otherActive = db
    .prepare("SELECT task_id, holder, paths FROM leases WHERE scope_id = ? AND state = 'active' AND task_id != ? AND suspended_at IS NULL")
    .all(scopeId, taskId) as { task_id: string; holder: string; paths: string | null }[];

  const overlaps: LeaseOverlap[] = [];
  const intentUnknown: string[] = [];
  for (const other of otherActive) {
    const otherPaths = other.paths !== null ? (JSON.parse(other.paths) as string[]) : undefined;
    if (paths === undefined || otherPaths === undefined) {
      intentUnknown.push(other.task_id);
      continue;
    }
    const pairs = intentOverlaps(paths, otherPaths);
    if (pairs.length > 0) overlaps.push({ taskId: other.task_id, holder: other.holder, pairs });
  }
  return { overlaps, intentUnknown };
}

/**
 * Persists a claim's overlaps (Spec 7.4) in both directions, so either task's own row names the
 * other. Called from both a local claim (src/store/claim.ts, origin "claim") and a replicated one
 * (src/store/materialize.ts, origin "sync"), so `ctxd rebuild` -- which replays every event through
 * the replicated path regardless of where it first originated -- reproduces the same rows a live
 * local claim already wrote, instead of creating new ones a live system never had.
 */
export function persistOverlaps(db: Database.Database, taskId: string, hlc: string, policy: string, overlaps: readonly LeaseOverlap[], origin: "claim" | "sync"): void {
  if (overlaps.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO claim_overlaps (task_id, other_task_id, detected_hlc, patterns, policy, origin) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, other_task_id) DO UPDATE SET detected_hlc = excluded.detected_hlc, patterns = excluded.patterns, policy = excluded.policy`,
  );
  for (const other of overlaps) {
    // `other.pairs` is {mine, theirs} from taskId's perspective (intentOverlaps(taskId's paths,
    // other's paths)): correct for the (taskId, other.taskId) row, backwards for the reverse row,
    // whose own "mine" must be other.taskId's own pattern.
    const fromTaskId = JSON.stringify(other.pairs);
    const fromOther = JSON.stringify(other.pairs.map((p) => ({ mine: p.theirs, theirs: p.mine })));
    upsert.run(taskId, other.taskId, hlc, fromTaskId, policy, origin);
    upsert.run(other.taskId, taskId, hlc, fromOther, policy, origin);
  }
}
