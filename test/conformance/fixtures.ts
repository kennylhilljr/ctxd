import type { CtxdHookEvent } from "../../src/hooks/adapters.js";

/**
 * Conformance fixtures (SPEC v6 section 9.7): one per event and variant, per client.
 *
 * Honest limitation: the spec calls for fixtures "captured from real client versions and
 * sanitized." This build has no way to run an actual Claude Code or Codex process and capture
 * its real hook stdin, so these are *constructed* from the documented JSON shapes in SPEC v6
 * 9.1, 9.4 and 9.5, not literally recorded. They exercise the same contract (field names per
 * adapter, output formats, exit-0 guarantee) but aren't a substitute for real captures if the
 * owner ever gets a chance to record genuine ones from a live client.
 *
 * Current-state honesty: every event now has a registered real handler (`pre-tool-use` the path
 * guard, slice 4; `session-start` the crash sweep plus read moments R1 to R4, slices 6 and 7;
 * `subagent-start` read moment R5, slice 7; `pre-compact`, `stop`, `session-end` and
 * `post-tool-use` the write moments W1 to W4, slice 8). None of these fixtures bind the
 * conformance kit's scratch repo to a scope, nor does its stdin `cwd` ("/scratch/sample-app")
 * resolve to a real git checkout, so each handler takes its own documented no-scope or no-git
 * fallback rather than doing real work:
 * - `session-start` prints the "not bound to a ctxd scope" notice (SPEC v6 9.1's "out-of-pool or
 *   unassigned notice"); `subagent-start` skips silently (R5's own fallback for the same case).
 * - `pre-compact` still writes its checkpoint file (that has no scope dependency at all), but
 *   produces no stdout either way (SPEC 9.2: "none; never blocks compaction").
 * - `stop` writes its checkpoint, then exits before the nudge check since there is no scope to
 *   nudge about.
 * - `session-end` and `post-tool-use` both require a scope to write a journal entry into, so with
 *   none bound they produce nothing.
 * A bound scope's real behavior (brief content, the nudge block, mechanical journal entries) is
 * exercised by `test/unit/brief.test.ts`, `test/unit/read-moments.test.ts` and
 * `test/unit/write-moments.test.ts`, not duplicated here; this kit is about the hook contract
 * (field names, output format, the exit-0 guarantee), not feature content.
 */

export interface ConformanceFixture {
  client: "claude-code" | "codex";
  event: CtxdHookEvent;
  /** A short label distinguishing this fixture from others for the same event (e.g. "startup" vs "resume"). */
  variant: string;
  stdin: Record<string, unknown>;
  expected: {
    exitCode: number;
    /** Whether this fixture's handler is expected to produce a block (Stop/PreToolUse only). */
    blocked?: boolean;
    blockReasonContains?: string;
    /** Whether this fixture's handler is expected to produce non-block text output. */
    textPresent?: boolean;
    textContains?: string;
  };
}

const NOTHING_YET = { exitCode: 0 }; // either no handler yet, or its documented no-scope/no-git fallback produces no output; see the file note above

function claudeCode(event: CtxdHookEvent, variant: string, stdin: Record<string, unknown>, expected: ConformanceFixture["expected"] = NOTHING_YET): ConformanceFixture {
  return { client: "claude-code", event, variant, stdin, expected };
}

function codex(event: CtxdHookEvent, variant: string, stdin: Record<string, unknown>, expected: ConformanceFixture["expected"] = NOTHING_YET): ConformanceFixture {
  return { client: "codex", event, variant, stdin, expected };
}

export const FIXTURES: ConformanceFixture[] = [
  // --- claude-code ---
  claudeCode(
    "session-start",
    "startup",
    { session_id: "cc-startup-1", cwd: "/scratch/sample-app", source: "startup" },
    { exitCode: 0, textPresent: true, textContains: "not bound to a ctxd scope" },
  ),
  claudeCode(
    "session-start",
    "resume",
    { session_id: "cc-resume-1", cwd: "/scratch/sample-app", source: "resume" },
    { exitCode: 0, textPresent: true, textContains: "not bound to a ctxd scope" },
  ),
  claudeCode("subagent-start", "default", { session_id: "cc-sub-1", cwd: "/scratch/sample-app" }),
  claudeCode("user-prompt-submit", "default", { session_id: "cc-prompt-1", cwd: "/scratch/sample-app" }),
  claudeCode("pre-compact", "default", { session_id: "cc-precompact-1", cwd: "/scratch/sample-app" }),
  claudeCode("stop", "normal", { session_id: "cc-stop-1", cwd: "/scratch/sample-app", last_assistant_message: "Working on it.", stop_hook_active: false }),
  claudeCode("stop", "loop-guard-already-active", { session_id: "cc-stop-2", cwd: "/scratch/sample-app", stop_hook_active: true }),
  claudeCode("session-end", "default", { session_id: "cc-end-1", cwd: "/scratch/sample-app" }),
  claudeCode(
    "pre-tool-use",
    "clean-path",
    { session_id: "cc-pretool-1", cwd: "/scratch/sample-app", tool_name: "Read", tool_input: { file_path: "/scratch/sample-app/README.md" } },
    { exitCode: 0 },
  ),
  claudeCode(
    "pre-tool-use",
    "guarded-path",
    { session_id: "cc-pretool-2", cwd: "/scratch/sample-app", tool_name: "Read", tool_input: { file_path: "GUARDED_DATA_DIR/ctxd.db" } },
    { exitCode: 0, blocked: true, blockReasonContains: "ctxd data is managed by the ctxd server" },
  ),
  claudeCode("post-tool-use", "default", { session_id: "cc-posttool-1", cwd: "/scratch/sample-app", tool_name: "Bash", tool_input: { command: "echo hi" } }),

  // --- codex (different field names: trigger instead of source, no stop_hook_active) ---
  codex(
    "session-start",
    "startup",
    { session_id: "cx-startup-1", cwd: "/scratch/sample-app", trigger: "startup" },
    { exitCode: 0, textPresent: true, textContains: "not bound to a ctxd scope" },
  ),
  codex(
    "session-start",
    "resume",
    { session_id: "cx-resume-1", cwd: "/scratch/sample-app", trigger: "resume" },
    { exitCode: 0, textPresent: true, textContains: "not bound to a ctxd scope" },
  ),
  codex("subagent-start", "default", { session_id: "cx-sub-1", cwd: "/scratch/sample-app" }),
  codex("user-prompt-submit", "default", { session_id: "cx-prompt-1", cwd: "/scratch/sample-app" }),
  codex("pre-compact", "default", { session_id: "cx-precompact-1", cwd: "/scratch/sample-app" }),
  codex("stop", "normal", { session_id: "cx-stop-1", cwd: "/scratch/sample-app", last_assistant_message: "Working on it." }),
  codex("session-end", "default", { session_id: "cx-end-1", cwd: "/scratch/sample-app" }),
  codex(
    "pre-tool-use",
    "clean-path",
    { session_id: "cx-pretool-1", cwd: "/scratch/sample-app", tool_name: "Read", tool_input: { file_path: "/scratch/sample-app/README.md" } },
    { exitCode: 0 },
  ),
  codex(
    "pre-tool-use",
    "guarded-path",
    { session_id: "cx-pretool-2", cwd: "/scratch/sample-app", tool_name: "Read", tool_input: { file_path: "GUARDED_DATA_DIR/ctxd.db" } },
    { exitCode: 0, blocked: true, blockReasonContains: "ctxd data is managed by the ctxd server" },
  ),
  codex("post-tool-use", "default", { session_id: "cx-posttool-1", cwd: "/scratch/sample-app", tool_name: "Bash", tool_input: { command: "echo hi" } }),
];
