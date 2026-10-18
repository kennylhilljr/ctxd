/**
 * Crash sweep (SPEC v6 section 9.10): run at the start of every SessionStart hook, bounded to
 * 300ms (src/hooks/handlers.ts wraps this call in withDeadline). Finalizes sessions on this node
 * that never reported a clean end (killed terminal, crash): idempotently marks them `ended` with
 * `ended_by: 'sweep'`, keeping `recovery` so the next brief for that client/scope still shows the
 * interrupted-work notice (SPEC 9.2).
 *
 * Deferred to later M2 slices, not silently skipped:
 * - The mechanical session journal entry (SPEC 9.1's SessionEnd row, "write the mechanical
 *   session log if missing") needs the same git facts (duration, branch, changed-file count) that
 *   M2 slice 8 (write moments) is building for a real SessionEnd; duplicating a partial version
 *   here would diverge from that path. Once slice 8 lands, this sweep should call its helper.
 * - Mechanical claim release (SPEC 7.5.4) needs a lease's `session_ref` and `base_head`, which
 *   `claimTask` (src/store/claim.ts) does not populate yet (both always null/absent); that's
 *   M2 slice 9 (claims, complete). Until it does, there is nothing a crashed session's leases
 *   query could correctly match against, so it is left for that slice to add alongside the fix.
 * - Leftover worker tickets (detached hook work, SPEC 9.7) have no writer yet; no M2 slice has
 *   added `ctxd worker` or ticket files, so there is nothing to sweep.
 */
import type Database from "better-sqlite3";
import { decodeHlc } from "../core/hlc.js";

export interface SweptSession {
  sessionRef: string;
  clientId: string;
}

/** Sessions on `nodeId` that stopped reporting more than `graceMinutes` ago are finalized as ended. */
export function crashSweep(db: Database.Database, nodeId: string, graceMinutes: number): SweptSession[] {
  const cutoff = Date.now() - graceMinutes * 60_000;
  const candidates = db
    .prepare(
      `SELECT s.session_ref, s.client_id, s.last_seen_hlc
       FROM sessions s JOIN clients c ON c.client_id = s.client_id
       WHERE c.node_id = ? AND s.state != 'ended'`,
    )
    .all(nodeId) as { session_ref: string; client_id: string; last_seen_hlc: string }[];

  const swept: SweptSession[] = [];
  const finalize = db.prepare("UPDATE sessions SET state = 'ended', ended_by = 'sweep' WHERE session_ref = ?");
  for (const row of candidates) {
    if (decodeHlc(row.last_seen_hlc).physical >= cutoff) continue;
    finalize.run(row.session_ref);
    swept.push({ sessionRef: row.session_ref, clientId: row.client_id });
  }
  return swept;
}
