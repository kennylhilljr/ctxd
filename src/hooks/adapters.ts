/**
 * Hook adapter descriptors (SPEC v6 section 9.7). The hook CLI core never branches on client
 * names directly; it asks the adapter for native event names, output format and timing limits.
 *
 * M2 scope note: these descriptors are transcribed from SPEC v6 9.1, 9.4 and 9.5, not verified
 * against a live Claude Code or Codex process (this build has no way to run one). The exact
 * `versions` ranges and field names are flagged "verify per client" in the spec itself; the
 * conformance-kit slice is where that gets pinned down against real (or at least carefully
 * researched) fixtures.
 */

export const CTXD_HOOK_EVENTS = [
  "session-start",
  "subagent-start",
  "user-prompt-submit",
  "pre-compact",
  "stop",
  "session-end",
  "pre-tool-use",
  "post-tool-use",
] as const;
export type CtxdHookEvent = (typeof CTXD_HOOK_EVENTS)[number];

export type HookOutputFormat = "stdout-text" | "additional-context" | "block-json" | "none";

export interface HookAdapter {
  id: string;
  /** Semver range the fixtures cover; see the file-level note above. */
  versions: string;
  events: Record<CtxdHookEvent, { native: string; output: HookOutputFormat; canBlock: boolean }>;
  /** Where to read inputs in the client's stdin JSON. */
  fields: {
    sessionId: string;
    cwd: string;
    source?: string;
    trigger?: string;
    prompt?: string;
    lastAssistantMessage?: string;
    stopHookActive?: string;
    toolName?: string;
    toolInput?: string;
  };
  limits: {
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    asyncSupported: boolean;
    sessionEndBudgetMs?: number;
    sessionStartMaxChars?: number;
    /** Events whose output this client ignores even when present. */
    outputIgnoredOn?: CtxdHookEvent[];
  };
}

export const CLAUDE_CODE_ADAPTER: HookAdapter = {
  id: "claude-code",
  versions: ">=1.0.0",
  events: {
    "session-start": { native: "SessionStart", output: "stdout-text", canBlock: false },
    "subagent-start": { native: "SubagentStart", output: "additional-context", canBlock: false },
    "user-prompt-submit": { native: "UserPromptSubmit", output: "additional-context", canBlock: false },
    "pre-compact": { native: "PreCompact", output: "none", canBlock: false },
    stop: { native: "Stop", output: "block-json", canBlock: true },
    "session-end": { native: "SessionEnd", output: "none", canBlock: false },
    "pre-tool-use": { native: "PreToolUse", output: "block-json", canBlock: true },
    "post-tool-use": { native: "PostToolUse", output: "none", canBlock: false },
  },
  fields: {
    sessionId: "session_id",
    cwd: "cwd",
    source: "source",
    lastAssistantMessage: "last_assistant_message",
    stopHookActive: "stop_hook_active",
    toolName: "tool_name",
    toolInput: "tool_input",
    prompt: "prompt",
  },
  limits: {
    defaultTimeoutMs: 600_000,
    maxTimeoutMs: 600_000,
    asyncSupported: true,
    sessionEndBudgetMs: 1500,
    sessionStartMaxChars: 9500,
  },
};

export const CODEX_ADAPTER: HookAdapter = {
  id: "codex",
  versions: ">=0.145.0",
  events: {
    "session-start": { native: "SessionStart", output: "stdout-text", canBlock: false },
    "subagent-start": { native: "SubagentStart", output: "additional-context", canBlock: false },
    "user-prompt-submit": { native: "UserPromptSubmit", output: "additional-context", canBlock: false },
    "pre-compact": { native: "PreCompact", output: "none", canBlock: false },
    stop: { native: "Stop", output: "block-json", canBlock: true },
    "session-end": { native: "SessionEnd", output: "none", canBlock: false },
    "pre-tool-use": { native: "PreToolUse", output: "block-json", canBlock: true },
    "post-tool-use": { native: "PostToolUse", output: "none", canBlock: false },
  },
  fields: {
    sessionId: "session_id",
    cwd: "cwd",
    trigger: "trigger",
    lastAssistantMessage: "last_assistant_message",
    toolName: "tool_name",
    toolInput: "tool_input",
    prompt: "prompt",
  },
  limits: {
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 3000,
    asyncSupported: false, // Codex runs "async" hooks synchronously (SPEC 9.5)
    outputIgnoredOn: ["session-end"],
  },
};

export const ADAPTERS: Readonly<Record<string, HookAdapter>> = {
  "claude-code": CLAUDE_CODE_ADAPTER,
  codex: CODEX_ADAPTER,
};
