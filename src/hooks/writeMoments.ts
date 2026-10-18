/**
 * Write moments W1 to W4 (PRD-hooks-v5 section 7.3, SPEC v6 9.2's PreCompact, Stop, SessionEnd
 * and PostToolUse rows): the mechanical, no-model-call hook writes. W5 to W8 are agent-instruction
 * moments (the agent itself calls context_write or context_claim) and have no hook handler at
 * all; they are not a gap in this slice, just not hook-driven.
 *
 * SessionEnd also attempts the mechanical claim release SPEC 7.5.4/9.2 call for "when its work
 * is committed": any active lease this session holds (by session_ref, M2 slice 9) is released if
 * HEAD has moved past the lease's base_head and the working tree is clean. Deferred, not silently
 * skipped:
 * - SessionEnd's work is specified to run in a detached worker (SPEC 9.7) since its own hook
 *   budget is short (1.5s Claude Code, 3s Codex). No M2 slice has added `ctxd worker` or ticket
 *   files yet, so this runs synchronously within the hook's existing deadline instead; a git
 *   status check and one DB write are fast enough to fit that budget in the normal case.
 * - PreCompact's `recovery` update ("phase and last request summary from the hook input") has no
 *   reliable source: Claude Code and Codex's documented PreCompact payloads carry no such field,
 *   only `session_id`/`cwd`/`trigger`. This only writes the checkpoint file, not a recovery guess.
 * - The crash sweep's own mechanical release (src/hooks/crashSweep.ts, for a session that never
 *   reaches SessionEnd at all) still can't do this: a crashed session has no live `cwd` to check
 *   "working tree clean" against, which is exactly what SessionEnd has and the sweep does not.
 *
 * Every write here goes through writeCtxOf's assumedPools, resolved from the client's own issued
 * persona token (store/snapshot.ts's resolveAssumedPools, same reasoning as src/hooks/readMoments.ts),
 * so a mechanical write respects exactly the pools the client was actually given, not every pool
 * it happens to be a member of.
 */
import { join } from "node:path";
import { decodeHlc, HlcClock } from "../core/hlc.js";
import { newId } from "../core/ids.js";
import { isFlagOn } from "../config/flags.js";
import { handleClaim } from "../store/claim.js";
import { resolveAssumedPools } from "../store/snapshot.js";
import { writeEntry, type WriteContext } from "../store/write.js";
import type { HookContext, HookResult } from "../cli/hook.js";
import { readStateFile, writeStateFileLocked } from "./stateFile.js";
import { evaluateStop, initialSessionState, type NudgeConfig, type SessionState, type StopObservation } from "./nudge.js";
import { gitBranch, gitChangedFiles, gitHead, headFingerprint, latestCommit, latestCommitFiles } from "./gitFacts.js";

interface Checkpoint {
  at: string;
  branch: string | null;
  head: string | null;
  changedFiles: string[];
  lastAssistantMessageExcerpt: string | null;
}

function sessionFilePath(ctx: HookContext, suffix: string): string {
  return join(ctx.dataDir, "sessions", `${ctx.sessionRef.replace(":", "-")}${suffix}`);
}

function writeCtxOf(ctx: HookContext): WriteContext {
  return {
    db: ctx.db,
    clock: new HlcClock(ctx.nodeId),
    nodeId: ctx.nodeId,
    clientId: ctx.clientId,
    assumedPools: resolveAssumedPools(ctx.db, ctx.clientId),
    flags: ctx.flags,
  };
}

function cwdOf(ctx: HookContext): string {
  return String(ctx.input[ctx.adapter.fields.cwd] ?? "");
}

function lastAssistantMessageOf(ctx: HookContext): string | null {
  const field = ctx.adapter.fields.lastAssistantMessage ? ctx.input[ctx.adapter.fields.lastAssistantMessage] : undefined;
  return typeof field === "string" ? field : null;
}

async function writeCheckpoint(ctx: HookContext, cwd: string): Promise<void> {
  const checkpoint: Checkpoint = {
    at: new Date().toISOString(),
    branch: gitBranch(cwd),
    head: gitHead(cwd),
    changedFiles: gitChangedFiles(cwd),
    lastAssistantMessageExcerpt: lastAssistantMessageOf(ctx)?.slice(0, 500) ?? null,
  };
  await writeStateFileLocked(sessionFilePath(ctx, ".checkpoint.json"), checkpoint);
}

/** W2: a mechanical checkpoint before compaction. Never blocks (SPEC 9.2). */
export async function preCompactHandler(ctx: HookContext): Promise<HookResult> {
  if (isFlagOn(ctx.flags, "hooks.checkpoint")) await writeCheckpoint(ctx, cwdOf(ctx));
  return undefined;
}

function latestHandoffAtMs(ctx: HookContext, scopeId: string): number | null {
  const row = ctx.db
    .prepare("SELECT MAX(updated_hlc) AS hlc FROM entries WHERE scope_id = ? AND kind = 'handoff' AND created_by = ?")
    .get(scopeId, ctx.clientId) as { hlc: string | null };
  return row.hlc ? decodeHlc(row.hlc).physical : null;
}

function latestHandoffSummary(ctx: HookContext, scopeId: string): string | null {
  const row = ctx.db
    .prepare("SELECT summary FROM entries WHERE scope_id = ? AND kind = 'handoff' AND created_by = ? ORDER BY updated_hlc DESC LIMIT 1")
    .get(scopeId, ctx.clientId) as { summary: string } | undefined;
  return row?.summary ?? null;
}

function scopeIdOf(ctx: HookContext): string | null {
  if (!ctx.scope) return null;
  const row = ctx.db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(ctx.scope) as { scope_id: string } | undefined;
  return row?.scope_id ?? null;
}

/** W1: the Stop-hook nudge check (SPEC 9.3), plus a working-tree checkpoint for the drift audit. */
export async function stopHandler(ctx: HookContext): Promise<HookResult> {
  const cwd = cwdOf(ctx);
  await writeCheckpoint(ctx, cwd);
  if (!ctx.scope) return undefined; // nothing to nudge about without a scope
  if (!isFlagOn(ctx.flags, "hooks.nudge")) return undefined; // never blocks; the checkpoint above still ran

  const config: NudgeConfig = {
    enabled: ctx.config?.nudge.enabled ?? true,
    minMinutesBetween: ctx.config?.nudge.min_minutes_between ?? 30,
    turnsThreshold: ctx.config?.nudge.turns_threshold ?? 20,
    completionMarkers: ctx.config?.nudge.completion_markers ?? ["done", "implemented", "merged", "complete"],
  };
  const path = sessionFilePath(ctx, ".json");
  const prev = readStateFile<SessionState>(path) ?? initialSessionState(ctx.scope, null);
  const scopeId = scopeIdOf(ctx);
  const stopHookActiveField = ctx.adapter.fields.stopHookActive ? ctx.input[ctx.adapter.fields.stopHookActive] : undefined;

  const obs: StopObservation = {
    now: Date.now(),
    head: headFingerprint(cwd),
    latestHandoffAt: scopeId ? latestHandoffAtMs(ctx, scopeId) : null,
    lastAssistantMessage: lastAssistantMessageOf(ctx),
    stopHookActive: stopHookActiveField === true,
  };
  const decision = evaluateStop(prev, obs, config);
  await writeStateFileLocked(path, decision.state);
  return decision.block ? { block: { reason: decision.reason! } } : undefined;
}

function sessionStartedAtMs(ctx: HookContext): number | null {
  const row = ctx.db.prepare("SELECT started_at FROM sessions WHERE session_ref = ?").get(ctx.sessionRef) as { started_at: string } | undefined;
  return row ? Date.parse(row.started_at) : null;
}

/** W3: a mechanical session journal entry when SessionEnd fires. Never blocks; errors are swallowed (SPEC 9.1, 9.2). */
export function sessionEndHandler(ctx: HookContext): HookResult {
  if (!ctx.scope) return undefined;
  const scopeId = scopeIdOf(ctx);
  if (!scopeId) return undefined;
  const cwd = cwdOf(ctx);
  const branch = gitBranch(cwd);
  const head = gitHead(cwd);
  const changedFiles = gitChangedFiles(cwd);
  const startedAt = sessionStartedAtMs(ctx);
  const durationMinutes = startedAt !== null ? Math.round((Date.now() - startedAt) / 60_000) : null;
  const handoffSummary = latestHandoffSummary(ctx, scopeId);

  const bodyLines = [
    `Client: ${ctx.clientName}`,
    durationMinutes !== null ? `Duration: ${durationMinutes} min` : null,
    branch ? `Branch: ${branch}` : null,
    head ? `HEAD: ${head}` : null,
    `Changed files: ${changedFiles.length}`,
    handoffSummary ? `Latest handoff: ${handoffSummary}` : null,
  ].filter((l): l is string => l !== null);

  try {
    writeEntry(writeCtxOf(ctx), {
      scope: ctx.scope,
      kind: "journal",
      title: `Session ended: ${ctx.clientName}`,
      body: bodyLines.join("\n"),
      significance: "routine",
      tags: ["auto"],
      request_id: newId(),
    } as never);
  } catch {
    // A failed mechanical record is not worth breaking SessionEnd over.
  }

  if (isFlagOn(ctx.flags, "claims.mechanical_release")) {
    releaseCommittedLeases(ctx, scopeId, head, changedFiles.length === 0);
  }
  return undefined;
}

/** Mechanical release (SPEC 7.5.4/9.2): this session's active leases whose work is committed and clean. */
function releaseCommittedLeases(ctx: HookContext, scopeId: string, head: string | null, treeClean: boolean): void {
  if (head === null || !treeClean) return; // unknown HEAD, or uncommitted work: leave the lease active
  const leases = ctx.db
    .prepare("SELECT task_id, base_head FROM leases WHERE scope_id = ? AND state = 'active' AND session_ref = ?")
    .all(scopeId, ctx.sessionRef) as { task_id: string; base_head: string | null }[];
  for (const lease of leases) {
    if (lease.base_head === null || lease.base_head === head) continue; // no baseline, or no commits since claim
    try {
      handleClaim(writeCtxOf(ctx), { scope: ctx.scope!, action: "release", task_id: lease.task_id, ttl_minutes: 120, session: ctx.sessionRef });
    } catch {
      // A failed mechanical release is not worth breaking SessionEnd over; the claim just stays active.
    }
  }
}

const GIT_COMMIT_COMMAND = /^\s*git\s+(?:-C\s+\S+\s+)?commit\b/;

function alreadyJournaled(ctx: HookContext, sha: string): boolean {
  const row = ctx.db.prepare("SELECT 1 FROM relations WHERE type = 'points_to' AND target = ? AND removed_event IS NULL LIMIT 1").get(`commit:${sha}`);
  return row !== undefined;
}

/**
 * W4: if the Bash command was a `git commit` invocation and HEAD now carries a commit this scope
 * hasn't journaled yet, record it. There is no tool-result field in the hook input to check the
 * command's exit status directly (SPEC 9.2 says "successful"), so "a new, not-yet-journaled
 * commit exists at HEAD" is used as the success signal instead: it only ever journals a commit
 * that actually landed, which is the property that matters here.
 */
export function postToolUseHandler(ctx: HookContext): HookResult {
  if (!ctx.scope) return undefined;
  const toolName = ctx.adapter.fields.toolName ? ctx.input[ctx.adapter.fields.toolName] : undefined;
  if (toolName !== "Bash" && toolName !== "bash") return undefined;
  const toolInput = ctx.adapter.fields.toolInput ? (ctx.input[ctx.adapter.fields.toolInput] as Record<string, unknown> | undefined) : undefined;
  const command = toolInput?.command;
  if (typeof command !== "string" || !GIT_COMMIT_COMMAND.test(command)) return undefined;

  const cwd = cwdOf(ctx);
  const commit = latestCommit(cwd);
  if (!commit || alreadyJournaled(ctx, commit.sha)) return undefined;

  const changedFiles = latestCommitFiles(cwd);
  try {
    writeEntry(writeCtxOf(ctx), {
      scope: ctx.scope,
      kind: "journal",
      title: commit.subject,
      body: changedFiles.length ? changedFiles.join("\n") : "(no file list)",
      significance: "routine",
      tags: ["auto"],
      links: [{ type: "points_to", ref: `commit:${commit.sha}` }],
      request_id: newId(),
    } as never);
  } catch {
    // A failed mechanical record is not worth breaking PostToolUse over.
  }
  return undefined;
}
