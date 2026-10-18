# ctxd Component PRD: Feature Flags (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-18 |
| **Parent** | [ctxd PRD v7](../PRD-v7.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v3.md), [Persona pools and access](PRD-pools-access-v2.md), [Hooks and agent lifecycle](PRD-hooks-v5.md), [Claims and write intent](PRD-claims-v3.md), [Trust and safety](PRD-trust-safety-v4.md), [Context hygiene](PRD-context-hygiene-v1.md), [Replication](PRD-replication-v4.md), [Briefs and search](PRD-briefs-search-v4.md), [Filesystem view](PRD-filesystem-view-v1.md), [Skills](PRD-skills-v1.md), [Memory and journal](PRD-memory-journal-v1.md) |
| **Spec** | Spec v8 (written in M3's first slice): configuration (section 3), the feature registry, `ctxd features` (section 13), and the per-feature off paths |
| **Parent requirements elaborated** | FR-57; NFR-11 |

## 1. Purpose

ctxd runs inside my daily work: hooks fire in every Claude Code and Codex session, sync moves data between Macs, and later milestones add backups, a mirror, semantic search and sealed pools. Any of these can misbehave. I need to switch any optional behavior off on one Mac in seconds, without uninstalling anything, losing data or waiting for a fix, and switch it back on later with everything caught up.

## 2. How flags work

- **One registry in code.** Every flag is declared once with its name, default, the milestone that introduced it, a one-line description, and what turning it off does. Nothing reads a flag that is not in the registry.
- **Per machine.** Flags live in that machine's `~/.config/ctxd/config.toml` under `[features]` and are never synced. Each Mac decides for itself.
- **Three layers, last one wins:** the registry default, then the config file, then an environment variable (`CTXD_FEATURE_<NAME>=0` or `1`, the name upper-cased with dots as underscores). The environment layer lets me disable something for one session or one command without editing a file.
- **Live.** The server applies a change within a few seconds without a restart. Hooks read flags locally from the config file and environment, never from the server, so a disabled hook returns at once with exit 0 even when the server is down.
- **Nested.** A parent flag turns off its children: `hooks` off silences every hook, whatever the individual hook flags say.
- **Visible.** `ctxd features` lists every flag with its effective value and where it came from (default, config or environment). `ctxd status` and `ctxd doctor` list anything switched off.
- **Human only.** `ctxd features set <name> on|off` writes the config file; agents cannot change flags through MCP tools.

## 3. Safety rules

- **Off never deletes.** Turning a feature off stops new work; it never removes or rewrites events, entries, files or configuration. Turning it back on resumes from the event log and catches up.
- **The tool surface stays fixed.** Disabling a feature never removes an MCP tool, so the tool list and its token cost do not change. A call that needs a disabled feature fails with `NOT_ALLOWED` and the hint "Feature `<name>` is disabled on this machine."
- **Hooks fail open.** With a hook feature off, that hook exits 0 with no output, as if ctxd were not installed.
- **Risky new features start off.** Anything that changes what leaves the machine (sync, backups copied elsewhere), writes outside ctxd's data folder (skill sync, the mirror) or needs hardware or keys (sealed pools, a local model) ships with its flag off.

## 4. Flags

| Flag | Default | From | Off means |
|---|---|---|---|
| `hooks` | on | M2 | Every hook exits 0 at once (the master switch) |
| `hooks.session_start` | on | M2 | No brief injected at session start, resume, compaction or for subagents |
| `hooks.nudge` | on | M2 | The Stop hook never blocks to ask for a handoff |
| `hooks.commit_journal` | on | M2 | Commits are not recorded or journaled |
| `hooks.session_end` | on | M2 | No session journal entry or mechanical claim release at session end |
| `hooks.checkpoint` | on | M2 | No PreCompact checkpoints |
| `hooks.crash_sweep` | on | M2 | Orphaned sessions are left as they are |
| `hooks.path_guard` | on | M2 | File tools may touch ctxd's data folder |
| `hooks.prompt_search` | off | M2 | No search on each prompt (read moment R7) |
| `claims.mechanical_release` | on | M2 | Claims are released only explicitly |
| `review.remembered_rules` | on | M2 | Remembered approval rules are ignored; everything proposed waits for review |
| `metering` | on | M1 | Response sizes are not recorded |
| `sync` | off | M3 | This machine neither pulls from nor serves peers; its log keeps growing locally and catches up when switched on |
| `sync.serve` | on | M3 | Peers cannot pull from this machine (it still pulls, if `sync` is on) |
| `backups` | off | M4 | No nightly backup |
| `backups.copy` | off | M4 | Backups stay on this machine (no copy to `copy_to`) |
| `statusline` | on | M4 | `ctxd statusline` prints nothing |
| `importance` | on | M5 | Briefs and search fall back to the Spec v6 ranking without importance |
| `semantic_search` | off | M5 | Full-text search only |
| `digest` | on | M5 | No weekly digests from this machine |
| `skills.native_sync` | off | M5 | Skills are not written into client skill folders, and nothing already synced is changed |
| `mirror` | off | M6 | The Markdown mirror is neither written nor watched |
| `signed_events` | off | M6 | New events are not signed; signatures on existing events are still verified |
| `sealed_pools` | off | M6 | Sealed pools stay locked and cannot be opened; their data stays encrypted |
| `local_model` | off | M6 | No local model summaries or suggestions |

## 5. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| FF-1 | One flag registry; every flag has a default, milestone, description and off behavior | FR-57 | P0 |
| FF-2 | Defaults, then config file, then environment variable; per machine; never synced | FR-57 | P0 |
| FF-3 | Live reload in the server; hooks read flags locally and exit 0 when off, even with the server down | FR-57, NFR-9 | P0 |
| FF-4 | Parent flags disable their children | FR-57 | P1 |
| FF-5 | `ctxd features` and `ctxd features set`; disabled flags shown by `status` and `doctor` | FR-57 | P0 |
| FF-6 | Off never deletes or rewrites data; on resumes and catches up | NFR-11 | P0 |
| FF-7 | The MCP tool list never changes with flags; disabled features answer `NOT_ALLOWED` with a hint | NFR-4 | P0 |
| FF-8 | Each flag has a test proving its off path is inert and that turning it back on resumes correctly | NFR-11 | P0 |

## 6. Acceptance criteria

- `CTXD_FEATURE_HOOKS=0 claude` starts a session in which no ctxd hook does anything, with no file edited.
- With `sync` switched off on the laptop for a day and back on, the laptop and the hub converge with nothing lost.
- `ctxd features set hooks.nudge off` takes effect at the next Stop without restarting anything.
- The `tools/list` payload is byte-for-byte the same with every flag off as with every flag on.
