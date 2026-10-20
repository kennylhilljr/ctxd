# ctxd LLD: Hooks and Agent Lifecycle (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) sections 3 (scope resolution) and 9 |
| **Implements** | [Hooks and agent lifecycle](../prd/components/PRD-hooks-v6.md) (HK-1 to HK-26); path guard and bypass from [Trust and safety](../prd/components/PRD-trust-safety-v5.md) (TS-13, TS-14) |
| **Owner** | A (agent-generated) by persona `component-designer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/hooks/` |
| **Moved from** | Spec v9 section 3 (scope resolution, bypass) and sections 9.1 to 9.11; Spec v10 draft W5.2 and the W5 PreCompact limitation |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 3.3 Scope resolution and bypass

Repositories hold no ctxd files. Bindings between repositories and scopes live only in ctxd's database (`scope_repos`), so scope and pool names never reach a repository or GitHub.

**Scope resolution order** (first match wins). Implements [PRD-hooks-v6](../prd/components/PRD-hooks-v6.md)) section 2.1.

1. **Repository identity.** Find the repository root by walking up to a `.git` directory or `.git` file (worktrees), read its config file directly (no `git` subprocess) and take `remote "origin"` `url`. Normalize it as follows, then look it up in `scope_repos`:
   - `git@host:owner/repo.git`, `ssh://git@host/owner/repo` and `https://host/owner/repo.git` all become `host/owner/repo`;
   - the result is lowercased and loses any trailing `.git`.
2. `scope_map` entry for the repository root path or `cwd` prefix.
3. **No match.** The session uses only `_me`. The SessionStart brief includes the notice: `This repository is not bound to a ctxd scope. Bind it with: ctxd scope bind <scope> --repo <normalized origin>`.

**Bypass.** Before resolution, if `CTXD_BYPASS` is `1` or `true`, or if `cwd` matches any glob in `hooks.bypass_patterns`, every hook exits 0 immediately with no output and no server call (9.9).

## 9. Hooks

### 9.1 Hook CLI contract

```
ctxd hook <event> --client <claude-code|codex> [--scope <name>]
```

- **Input:** reads the hook JSON from stdin. Uses `session_id`, `cwd`, `hook_event_name`, `source` or `trigger`, `transcript_path`, and `last_assistant_message` when present **(verify field names per client)**.
- **Scope:** resolved from `cwd` (section 3) unless `--scope` is given.
- **Token:** loaded from `~/.config/ctxd/tokens/<client>.token`.
- **Output:** per event and client, as specified below.
- **Exit code:** 0 in all failure cases except an intentional Stop block, so ctxd never breaks a session.
- **Deadline:** an internal budget of 80% of the adapter's limit for that event (9.7), and never more than 1 second for synchronous work on SessionStart and Stop. Work that cannot finish in time is detached (9.7). If the server is unreachable, the hook prints a short notice where context injection is allowed, and otherwise prints nothing.

### 9.2 Event handling

| Hook event | Clients | ctxd action | Output |
|---|---|---|---|
| SessionStart `startup` | both | Run the crash sweep (9.10); compute the session working set (10.5, honoring `CTXD_POOL`); build the `normal` brief from it within `session_start_max_chars`, adding the out-of-pool or unassigned notice when applicable; register `session_ref`; record session-start | Plain text brief on stdout (becomes context) |
| SessionStart `resume`, `fork` | both | `micro` brief plus changes since the session's last read | stdout |
| SessionStart `compact`, PostCompact | both | `micro` brief plus latest handoff | stdout (Codex PostCompact output handling: verify) |
| SessionStart `clear` | both | `micro` brief | stdout |
| SubagentStart | both | `micro` brief | `hookSpecificOutput.additionalContext` |
| UserPromptSubmit | both | If `hooks.prompt_search` is on (default off, 3.1) and a scope is bound: FTS on the prompt's word tokens; up to 3 matching titles | `additionalContext`; nothing if disabled, unbound, or no match |
| PreCompact | both | Mechanical checkpoint: branch, HEAD, `git status --porcelain` summary, last assistant message excerpt (500 chars, redacted) | none; never blocks compaction |
| Stop | both | Nudge check (9.3); record a working-tree checkpoint (changed file list, redacted) for the drift audit | Either nothing, or `{"decision":"block","reason":"..."}` |
| SessionEnd | Claude Code; Codex rust-v0.145.0 and later | Write the end marker, then hand off to a detached worker: a mechanical session `journal` entry (significance `routine`, tag `auto`: client, duration, branch, HEAD, number of changed files, and the summary of this session's latest handoff if any) and mechanical claim release when its work is committed (7.5.4) | none (cannot block; Claude Code 1.5 second budget; Codex at most 3 seconds and output ignored) |
| PreToolUse (file tools, Bash) | both | Path guard (9.9) | Deny with a reason when a ctxd data path is targeted; otherwise nothing |
| PostToolUse (Bash) | both | If the command was a successful `git commit`: record the commit in the local `commits` table (7.5.6) and write a `journal` entry (significance `routine`, tag `auto`) titled with the commit subject, with the changed file list in its body and a `points_to commit:<sha>` link | none |

**Session state and recovery intent** (implements [PRD-hooks-v6](../prd/components/PRD-hooks-v6.md)) HK-12 and HK-13). Every hook call upserts the `sessions` row for its session reference:

| Event | `state` | `recovery` update |
|---|---|---|
| SessionStart | `active` | Cleared on `startup`; kept on `resume` and `compact` |
| PreCompact | `compacting` | Phase and last request summary from the hook input (sanitized, one line) |
| PostCompact (Codex) or SessionStart `compact` | `active` | Unchanged |
| Stop | `idle` | Phase set to the active claim's task, if any |
| SessionEnd | `ended` | Cleared when no claim is held |

A session not seen for 6 hours while `active` or `compacting` is shown as `unknown` in claims and briefs, until the crash sweep (9.10) finalizes it.

**Accepted limitation: PreCompact phase and summary.** PreCompact writes only the mechanical checkpoint file (branch, HEAD, changed files). The phase and last request summary in the table above have no reliable source: neither Claude Code's nor Codex's documented PreCompact payload carries one, only `session_id`, `cwd` and `trigger`. Revisit only if a client adds such a field. (Spec v10 draft, W5.)

### 9.3 Nudge check

Per-session state lives in `sessions/<client>-<session_id>.json`:

```json
{ "scope": "ctxd", "started_at": "...", "turns": 14, "last_head": "3fa2c1e",
  "last_handoff_at": null, "last_nudge_at": null, "nudge_pending": false }
```

**Algorithm on Stop:**

1. **Loop guard.** If `nudge_pending` is true, or the client's "stop hook active" flag is true (verify per client), set `nudge_pending = false`, record whether a handoff was written since `last_nudge_at`, and exit 0 without output.
2. **Count the turn.** Increment `turns`.
3. **Check for a recent handoff.** If this client wrote a handoff in this scope within `min_minutes_between`, exit 0.
4. **Evaluate triggers.** The nudge is due if any of these holds:
   - HEAD or the working tree changed since `last_head` or the last handoff;
   - `turns` is at least `turns_threshold`;
   - `last_assistant_message` contains a completion marker.
5. **Rate limit.** If a trigger holds and `last_nudge_at` is older than `min_minutes_between`:
   - set `nudge_pending = true` and `last_nudge_at = now`;
   - print the block JSON with the reason text from [Hooks v6](../prd/components/PRD-hooks-v6.md)) section 6, filled with the scope and session.
6. **Otherwise** exit 0.

The reason text explicitly allows "no handoff needed," so a nudge never forces filler. Besides the handoff, it asks for lessons, lasting preferences the user stated, procedures worth saving as skills, and a `blocker` journal entry when the agent is blocked; each of these is optional.

### 9.4 Claude Code configuration

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "ctxd", "args": ["hook", "session-start", "--client", "claude-code"], "timeout": 5 }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "ctxd", "args": ["hook", "subagent-start", "--client", "claude-code"], "timeout": 5 }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "ctxd", "args": ["hook", "pre-compact", "--client", "claude-code"], "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "ctxd", "args": ["hook", "stop", "--client", "claude-code"], "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "ctxd", "args": ["hook", "session-end", "--client", "claude-code"], "timeout": 2 }] }],
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "ctxd", "args": ["hook", "post-tool-use", "--client", "claude-code"], "timeout": 5, "async": true }] }],
    "PreToolUse": [{ "matcher": "Read|Edit|Write|MultiEdit|Glob|Grep|Bash", "hooks": [{ "type": "command", "command": "ctxd", "args": ["hook", "pre-tool-use", "--client", "claude-code"], "timeout": 3 }] }]
  }
}
```

MCP registration:

```bash
claude mcp add --scope user ctxd -- ctxd mcp --client claude-code
```

This is the only MCP entry; it is identical in every project and names no scope or pool. The launcher picks the persona (8.4).

### 9.5 Codex configuration

```toml
[mcp_servers.ctxd]
command = "ctxd"
args = ["mcp", "--client", "codex"]

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "ctxd hook session-start --client codex"
timeout = 3

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "ctxd hook stop --client codex"
timeout = 3

[[hooks.PreCompact]]
[[hooks.PreCompact.hooks]]
type = "command"
command = "ctxd hook pre-compact --client codex"
timeout = 3

[[hooks.PostCompact]]
[[hooks.PostCompact.hooks]]
type = "command"
command = "ctxd hook post-compact --client codex"
timeout = 3

[[hooks.PostToolUse]]
matcher = "^Bash$"
[[hooks.PostToolUse.hooks]]
type = "command"
command = "ctxd hook post-tool-use --client codex"
timeout = 3

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "ctxd hook pre-tool-use --client codex"
timeout = 3

[[hooks.SessionEnd]]
[[hooks.SessionEnd.hooks]]
type = "command"
command = "ctxd hook session-end --client codex"
timeout = 3
```

Codex clamps hook timeouts to 3 seconds and runs `async` hooks synchronously; all Codex timeouts above are therefore 3 or less, and slow work is detached (9.7).

New or changed hooks must be approved once in Codex's `/hooks` browser before they run.

### 9.6 Claude Desktop (chats)

```json
{
  "mcpServers": {
    "ctxd": {
      "command": "ctxd",
      "args": ["stdio", "--client", "claude-desktop"]
    }
  }
}
```

Project instructions template (one per Desktop project):

```
This project uses ctxd scope "<scope>". At the start of each chat, call context_brief for that
scope. When we settle a decision, record it with context_write (kind decision, with the reason).
When we reach a conclusion or wrap up, offer to save a handoff with context_handoff.
```

### 9.7 Hook adapters and conformance kit

Implements [PRD-hooks-v6](../prd/components/PRD-hooks-v6.md)) section 7. Every client integration is a frozen **adapter descriptor** in `src/hooks/adapters/<client>.ts`. The hook CLI core never branches on client names; it asks the adapter.

```ts
interface HookAdapter {
  id: "claude-code" | "codex" | string;   // new clients add an id
  versions: string;                       // semver range the fixtures cover
  events: Record<CtxdHookEvent, {
    native: string;                       // client event name, e.g. "SessionStart"
    output: "stdout-text" | "additional-context" | "block-json" | "none";
    canBlock: boolean;
  }>;
  fields: {                               // where to read inputs in the client's stdin JSON
    sessionId: string; cwd: string; source?: string; trigger?: string;
    lastAssistantMessage?: string; stopHookActive?: string; toolName?: string; toolInput?: string;
  };
  limits: {
    defaultTimeoutMs: number;             // Codex about 1000; Claude Code 600000 for most events
    maxTimeoutMs: number;                 // Codex clamps to 3000
    asyncSupported: boolean;              // Codex runs async hooks synchronously
    sessionEndBudgetMs?: number;          // Claude Code 1500
    sessionStartMaxChars?: number;        // Claude Code about 10000 inline; ctxd uses 9500
    outputIgnoredOn?: CtxdHookEvent[];    // Codex ignores SessionEnd output
  };
}
```

**Conformance kit** (`test/conformance/`):

- **Recorded fixtures.** Each client gets a directory of recorded stdin fixtures, one per event and variant (for example `startup`, `resume`, `compact`, a stop with the active flag, a git commit). Fixtures are captured from real client versions and sanitized before they are committed.
- **Expected results.** Each fixture has expected stdout, exit code and resulting server calls. The server is a deterministic in-process fake, so no network or provider is involved.
- **Cross-checks against the descriptor.** The runner fails if:
  - a descriptor claims an event that has no fixture;
  - output does not match the declared format;
  - a non-blocking event ever exits non-zero.
- **Adding a client.** Write a descriptor and fixtures. Core code changes are a review flag.
- **Isolation.** The kit runs in CI under a temporary home directory and never touches real client configuration.

**Detached workers.** When a hook's work cannot fit the adapter's time limit (SessionEnd commits, mechanical release, large checkpoints), the hook:

1. writes an end marker or work ticket file (atomic, 9.8);
2. spawns `ctxd worker <ticket>` as a detached process (new session, stdio closed);
3. exits 0.

The worker takes the per-session lock, does the work, and removes the ticket. Tickets left behind (for example after a reboot) are picked up by the next crash sweep.

### 9.8 Hook state files

Per-session state (9.3) and checkpoints are small JSON files under `sessions/`. To avoid torn or racing writes when several hooks fire together (for example async PostToolUse and Stop):

- **Locking.** Each write takes a per-session lock file created with exclusive-create semantics. Waits are bounded to 200 ms; a stale lock older than 5 seconds whose owner process is gone is broken.
- **Atomic replace.** Writes go to a temporary file in the same directory, are fsynced, then renamed over the target.
- **Lock timeout.** If the lock cannot be taken in time, the hook skips its state update and exits 0. A missed nudge or checkpoint is acceptable; a blocked or broken session is not.
- **Cleanup.** Session files older than 14 days are removed by the nightly maintenance job.

### 9.9 Path guard and bypass

Implements [PRD-trust-safety-v5](../prd/components/PRD-trust-safety-v5.md)) TS-13 and TS-14.

- **Path guard.** The PreToolUse hook inspects file-tool inputs (`file_path`, `path`, glob patterns) and, for Bash, the command text. If any resolves under the ctxd data directory or `~/.config/ctxd/`, it denies the call with the reason: `ctxd data is managed by the ctxd server. Use context_search or context_get to read it, and context_write to change it.` Matching is by path prefix after `~` expansion and normalization; it is a guard against accidents and casual bypass, not a sandbox.
- **Bypass.** Checked first in every hook, before reading stdin fully or contacting the server (3). A bypassed session also skips the path guard, which is acceptable because a bypassed session never has ctxd tools injected.

### 9.10 Crash sweep

Implements [PRD-hooks-v6](../prd/components/PRD-hooks-v6.md)) section 7.1. Runs at the start of every SessionStart hook (bounded to 300 ms; remaining work is detached):

1. Select `sessions` on this node with state other than `ended` and `last_seen_hlc` older than `crash_grace_minutes`, plus any leftover worker tickets.
2. For each, idempotently:
   - set the state to `ended`, recording `ended_by: "sweep"`;
   - write the mechanical session log if missing;
   - run the mechanical claim release if its work is committed (7.5.4);
   - keep `recovery` so the next brief for that client and scope shows the interrupted-work notice.
3. End markers carry their creation time in the file name. A real SessionEnd that arrives after the sweep finds the session already ended and only fills missing fields.
4. **Mechanical work for a crashed session.** For a finalized session that has a recorded `cwd` (`sessions.cwd`, set once at SessionStart) and a scope, the sweep runs the same mechanical journal entry and claim release a real SessionEnd runs (`performSessionEnd`), gated behind `claims.mechanical_release`, the flag that already gates live SessionEnd's release. A session with no recorded `cwd` (a row from before schema version 20) or no scope is only finalized. (Spec v10 draft W5.2.)

### 9.11 Status line and sources-used card

- **`ctxd statusline`** prints one line for Claude Code's status line setting, for example `ctxd ● ctxd · brief ✓ · 2 claims · 3 unsynced`. It reads only local state and finishes within 50 ms.
- **`ctxd status`** prints the same information with detail.
- **Sources-used card (optional).** Where Claude Code supports plugin display modules, a module renders a collapsed line under each answer listing the ctxd references injected or read during that turn, for example `ctxd · 6 entries · 2 decisions · 1 handoff · 1 claim`. The hook layer records references per turn in the session state file. It is off when unsupported (verify the module API at implementation time).
