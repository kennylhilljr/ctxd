/**
 * Crash sweep (SPEC v6 section 9.10): run at the start of every SessionStart hook, bounded to
 * 300ms (src/hooks/handlers.ts wraps this call in withDeadline). Finalizes sessions on this node
 * that never reported a clean end (killed terminal, crash): idempotently marks them `ended` with
 * `ended_by: 'sweep'`, keeping `recovery` so the next brief for that client/scope still shows the
 * interrupted-work notice (SPEC 9.2).
 *
 * `sweepLeftoverTickets` below closes this file's own previously-documented gap: a SessionEnd
 * work ticket (SPEC 9.7) left behind by a reboot before its worker ran, or a worker that crashed
 * mid-run, is picked up here rather than sitting forever. It is a separate exported function, not
 * folded into `crashSweep` itself, since the two work on different things (sessions vs. ticket
 * files) and `crashSweep`'s own signature and tests should not need to change to gain it.
 *
 * Still deferred, not silently skipped:
 * - The mechanical session journal entry (SPEC 9.1's SessionEnd row, "write the mechanical
 *   session log if missing") for a session that crashes without ever reaching SessionEnd (so no
 *   ticket is ever written) needs the same git facts a real SessionEnd's ticket carries (branch,
 *   HEAD, changed-file count) from a `cwd` a crashed session no longer has a live process to read.
 * - Mechanical claim release for that same crashed-with-no-ticket case has the identical problem:
 *   "is the working tree clean" has no answer without a live `cwd` to check it against.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { decodeHlc } from "../core/hlc.js";
import { readStateFile, withLock } from "./stateFile.js";
import { applySessionEndTicket, type SessionEndTicket } from "./writeMoments.js";

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

/**
 * SessionEnd ticket files (`sessions/*.ticket.json`) older than `graceMinutes`: a fresh one is
 * left alone, since its own spawned worker is most likely still running. Each is processed under
 * its own lock, same as `ctxd worker` itself uses, so the two never race on the same ticket.
 */
export async function sweepLeftoverTickets(db: Database.Database, nodeId: string, dataDir: string, graceMinutes: number, flags?: Map<string, boolean>): Promise<string[]> {
  const sessionsDir = join(dataDir, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const cutoff = Date.now() - graceMinutes * 60_000;
  const swept: string[] = [];

  for (const file of readdirSync(sessionsDir)) {
    if (!file.endsWith(".ticket.json")) continue;
    const path = join(sessionsDir, file);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat (its own worker just finished it)
    }
    if (mtimeMs > cutoff) continue; // fresh enough that its own worker may still be running

    await withLock(path, () => {
      const ticket = readStateFile<SessionEndTicket>(path);
      if (ticket) applySessionEndTicket(db, nodeId, ticket, flags);
      if (existsSync(path)) unlinkSync(path);
    });
    swept.push(file);
  }
  return swept;
}
