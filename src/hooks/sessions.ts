/**
 * Sessions table upserts (SPEC v6 section 9.2's "session state and recovery intent" table, and
 * 9.3's HK-12/HK-13): every hook call upserts the `sessions` row for its session reference.
 */
import type Database from "better-sqlite3";
import { HlcClock } from "../core/hlc.js";
import { nowIso } from "../core/time.js";
import type { CtxdHookEvent } from "./adapters.js";

export interface RecoveryIntent {
  task_id?: string;
  phase: string;
  last_request_summary: string;
}

type SessionState = "active" | "compacting" | "idle" | "ended";

/** SPEC 9.2's event -> state column. Events not listed here don't change session state at all. */
const STATE_FOR_EVENT: Partial<Record<CtxdHookEvent, SessionState>> = {
  "session-start": "active",
  "pre-compact": "compacting",
  stop: "idle",
  "session-end": "ended",
};

export interface UpsertSessionInput {
  sessionRef: string;
  clientId: string;
  scopeId: string | null;
  event: CtxdHookEvent;
  nodeId: string;
  /** SessionStart "startup" clears recovery; "resume" and "compact" keep it (SPEC 9.2). */
  clearRecovery?: boolean;
  /** Explicit recovery to set (e.g. PreCompact's phase and summary); omit to leave the existing value alone. */
  recovery?: RecoveryIntent | null;
  head?: string | null;
}

/** Whether this event changes session state at all (subagent-start, user-prompt-submit, pre/post-tool-use don't). */
export function eventTouchesSessionState(event: CtxdHookEvent): boolean {
  return event in STATE_FOR_EVENT;
}

export function upsertSession(db: Database.Database, input: UpsertSessionInput): void {
  const state = STATE_FOR_EVENT[input.event];
  if (!state) return;
  const hlc = new HlcClock(input.nodeId).tick();
  const existing = db.prepare("SELECT recovery, started_at FROM sessions WHERE session_ref = ?").get(input.sessionRef) as
    | { recovery: string | null; started_at: string }
    | undefined;
  const recovery = input.clearRecovery ? null : input.recovery !== undefined ? (input.recovery ? JSON.stringify(input.recovery) : null) : existing?.recovery ?? null;
  const startedAt = existing?.started_at ?? nowIso();

  db.prepare(
    `INSERT INTO sessions (session_ref, client_id, scope_id, state, started_at, last_seen_hlc, head, recovery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_ref) DO UPDATE SET
       client_id = excluded.client_id, scope_id = excluded.scope_id, state = excluded.state,
       last_seen_hlc = excluded.last_seen_hlc, head = excluded.head, recovery = excluded.recovery`,
  ).run(input.sessionRef, input.clientId, input.scopeId, state, startedAt, hlc, input.head ?? null, recovery);
}
