/**
 * Stop-hook nudge state machine (PRD-hooks-v5 section 6, SPEC v6 section 9.3).
 * Pure function: callers load and persist SessionState and gather the observations.
 */

export interface NudgeConfig {
  enabled: boolean;
  minMinutesBetween: number;
  turnsThreshold: number;
  completionMarkers: string[];
}

export interface SessionState {
  scope: string;
  turns: number;
  lastHead: string | null;
  lastHandoffAt: number | null;
  lastNudgeAt: number | null;
  nudgePending: boolean;
}

export interface StopObservation {
  now: number;
  /** Current git HEAD plus a working-tree fingerprint, or null outside git. */
  head: string | null;
  /** Latest handoff by this client in this scope, from the server. */
  latestHandoffAt: number | null;
  lastAssistantMessage: string | null;
  /** The client's own "stop hook already active" flag, when it provides one. */
  stopHookActive: boolean;
}

export interface NudgeDecision {
  block: boolean;
  reason?: string;
  state: SessionState;
}

export function nudgeReason(scope: string): string {
  return (
    `Before finishing: call context_handoff for scope "${scope}" with what you did, what is next, ` +
    `and open questions. Record new decisions with context_write, and anything worth keeping: a lesson ` +
    `(kind lesson), a lasting preference the user stated (kind preference), or a procedure that worked ` +
    `and will recur (kind skill). If you are blocked, log it (kind journal, significance blocker). ` +
    `If nothing material changed since the last handoff, reply "no handoff needed" and stop.`
  );
}

export function evaluateStop(
  prev: SessionState,
  obs: StopObservation,
  config: NudgeConfig,
): NudgeDecision {
  const minGapMs = config.minMinutesBetween * 60_000;
  const state: SessionState = {
    ...prev,
    lastHandoffAt: maxOrNull(prev.lastHandoffAt, obs.latestHandoffAt),
  };

  // 1. Loop guard: never block twice in a row.
  if (state.nudgePending || obs.stopHookActive) {
    return { block: false, state: { ...state, nudgePending: false, lastHead: obs.head } };
  }

  // 2. Count the turn.
  state.turns += 1;

  if (!config.enabled) return { block: false, state };

  // 3. A recent handoff satisfies the nudge.
  if (state.lastHandoffAt !== null && obs.now - state.lastHandoffAt < minGapMs) {
    return { block: false, state: { ...state, turns: 0, lastHead: obs.head } };
  }

  // 4. Triggers.
  const headChanged = obs.head !== null && obs.head !== state.lastHead;
  const manyTurns = state.turns >= config.turnsThreshold;
  const message = (obs.lastAssistantMessage ?? "").toLowerCase();
  const completed = config.completionMarkers.some((m) => message.includes(m.toLowerCase()));
  const triggered = headChanged || manyTurns || completed;

  // 5. Rate limit.
  const nudgedRecently = state.lastNudgeAt !== null && obs.now - state.lastNudgeAt < minGapMs;
  if (triggered && !nudgedRecently) {
    return {
      block: true,
      reason: nudgeReason(state.scope),
      state: { ...state, nudgePending: true, lastNudgeAt: obs.now, turns: 0, lastHead: obs.head },
    };
  }

  return { block: false, state };
}

export function initialSessionState(scope: string, head: string | null): SessionState {
  return { scope, turns: 0, lastHead: head, lastHandoffAt: null, lastNudgeAt: null, nudgePending: false };
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
