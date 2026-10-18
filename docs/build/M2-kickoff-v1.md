# M2 kickoff: hooks, claims, hygiene and the daily loop (v1)

Instructions for the agent building M2. Read this whole file, then AGENTS.md, before doing anything else. This file is the approved scope for M2; do not add milestones beyond it, and do not stop between slices to ask for permission once the plan is approved.

## 0. Ground rules for this milestone

- **Hooks run in the owner's real sessions once installed, so the build never installs them.** Never write to the real `~/.claude`, `~/.codex`, `~/.config/ctxd` or real ctxd data. Develop and test hooks only through recorded fixtures and the conformance kit, and for live checks use throwaway config folders (for example `CLAUDE_CONFIG_DIR` and `CODEX_HOME` pointing at a fresh temporary folder, plus a scratch ctxd data directory). Verify those variables at the pinned client versions before relying on them, and if one is not supported, stop and say so rather than touching real configuration.
- **A hook can never break a session** (Spec 9.1): every code path exits 0 except an intentional Stop block, stays inside its time budget, and makes zero server calls when bypassed. Each of these gets a test.
- **Invented names only** in code, tests, fixtures and commit messages (AGENTS.md).
- **Commits use the owner's configured git identity**, with your `Co-Authored-By` trailer (AGENTS.md).
- **The ctxd-build mod tracks M2:** run `/ctxd-build milestone M2` once, then track each slice with the task list (TaskCreate, then TaskUpdate to `in_progress` and `completed`).

## 1. Start from M1

M1 is nine stacked PRs (#1 to #9). Before planning, check whether they have been merged:

- If they are merged, branch M2 slices from `main`.
- If they are not, branch the first M2 slice from `m1/exit-spec-v7` and say so in its PR, so the stack stays reviewable.

## 2. First slice: turn the M1 findings into a real Spec v7

`docs/spec/SPEC-v7.md` on the M1 branch is a changelog of findings, not a spec. Version history says each numbered spec is a complete document, so:

- Replace it with a complete `SPEC-v7.md`: Spec v6 plus the resolutions below, a "Changes in v7" table at the top, and the M1 findings kept as a short appendix for traceability. If PR #9 is already merged, write the full spec as `SPEC-v7.md` anyway only if v7 is still the changelog file that nobody has built on; otherwise use `SPEC-v8.md`. Never edit Spec v6.
- Update the parent PRD's companion-doc link, AGENTS.md and the README to point at the new spec in a follow-up PRD version only if the PRD itself changes; otherwise update just AGENTS.md and the README.
- Regenerate `src/store/schema.ts` from the new spec if the SQL changed.

Resolutions (decided; implement them as written):

| Finding | Resolution |
|---|---|
| 10.4 `review_policy` default `'{}'` vs "a JSON list" | The column holds a list. Change the schema default to `'[]'`. |
| 7.6.6 purge replay leaves no row after a rebuild | A `purge` event carries `scope_id`, `kind` and `slug` along with the fingerprint, and applying it upserts the stub row regardless of replay order. A rebuild after a purge reproduces the stub exactly. Add a property test: random event orders including purges rebuild to the same state hash. |
| 11.1 no budget for a plain `context_brief` call | Keep M1's choice and write it down: normal 9,500, micro 3,000, full 28,500 characters, and the hook cap stays 9,500. |
| 11.2 `scope: "*"` has no home scope | Intentional. With a session scope known (M2 sessions), that scope ranks at 1.0, `_me` and profiles at 0.9, others at 0.8; with none known, `_me` and profiles 0.9 and everything else 0.8. |
| 4.3 `skill:<name>` has no session scope in `context_get` | No new tool parameter (footprint). The server uses the session's resolved scope, which the launcher and hooks now record on the session row; without one, M1's behavior stands. |
| 11.4 cross-scope `resolved` links | Same-scope only in v7, stated explicitly. |
| 8.4 Keychain through the `security` binary | Accepted: every node is a Mac (PRD section 4). State that the secret store is macOS Keychain via `security`, behind one module so it can be swapped later. |
| 4 genesis inserts in `ctxd init` | State the one exception explicitly: `init` writes the node, the human client and `_me` directly; every later change is an event. |
| 6 step 1 held writes to a scope in no pool | Open an `access_requests` row with `pool_ids = '[]'` so it is reviewable; approving it creates a temporary or permanent client grant. |
| 7.5 commit facts have no table | Add a local `commits` table (sha, scope, session, subject, changed files, time) written by the PostToolUse hook, used for drift and stale-claim facts. Commits still also become `journal` entries (Spec v6 9.2). |

## 3. M2 scope

From PRD v6 section 10 (the M2 row), minus what M1 already delivered (`ls`, `tree`, `read`, basic claim, release and list with overlap, open signals and the skill catalog in briefs):

1. **Hook core.** `ctxd hook <event> --client <claude-code|codex>`: stdin parsing through declared adapters, per-event deadlines, exit-0 guarantee, the session state files with locking and atomic replace (9.8), bypass (`CTXD_BYPASS`, `hooks.bypass_patterns`), and detached workers (9.7).
2. **Adapters and conformance kit** for Claude Code and Codex (9.7), with recorded, sanitized fixtures per event and variant, including Codex SessionEnd (rust-v0.145.0 and later) and its 3-second clamp.
3. **Scope resolution from git origin** without a `git` subprocess (3), `ctxd scope bind`, the `_me`-only fallback notice, and the launcher using the same resolution so tools and hooks agree (8.4).
4. **Sessions.** The `sessions` table written by every hook call, persona recorded per session, the brief's `session` field, liveness states for claims, and the interrupted-work notice (11.1).
5. **Read moments R1 to R5.** SessionStart `startup` (normal brief, capped at 9,500 characters), `resume`, `compact`, `clear`, and SubagentStart (micro briefs).
6. **Write moments W2 to W4 and W1.** PreCompact checkpoint; PostToolUse commit facts plus a `journal` entry per commit; SessionEnd session `journal` entry with mechanical claim release through a detached worker; the Stop-hook nudge wired to the existing state machine with its v6 reason text.
7. **Crash sweep** (9.10) for sessions that ended without a SessionEnd.
8. **Claims, complete.** Drift audit from commit facts, stale-claim facts (`commits_since_claim`, holder session state), recorded takeovers, and brief notices for lost, taken-over and overlapping claims.
9. **Path guard** on PreToolUse (9.9), including the mirror folder.
10. **Hygiene.** Quarantine, revert and release with batches (7.6.2 to 7.6.4), claim suspension during quarantine, and access requests in review.
11. **`ctxd review`.** One interactive queue: proposed entries, conflicts, drift, takeovers, access requests (approve, grant for a time, add to pool, deny), held writes, and skill name clashes.
12. **Memory and journal commands.** `ctxd remember`, `ctxd log`, `ctxd journal`, `ctxd signals`.
13. **`ctxd install-hooks --client <id> --dry-run`.** Prints the exact hook and MCP configuration it would write. Writing for real (with confirmation and a backup) is implemented and tested against a temporary config folder only.

**Not in M2** (do not start these): native skill sync, scope rollback, `ctxd tidy`, weekly digests and importance-driven tidy (M5); the Markdown mirror and import (M6); replication (M3); launchd, backups and the status line (M4).

## 4. Exit criterion

On one Mac, using only throwaway config folders and a scratch data directory:

- A simulated day (driven by conformance fixtures and the real `ctxd hook` binary) produces briefs at session start, a nudged handoff, journal entries for commits and session ends, and a finalized session after a simulated crash.
- Two agents (one Claude Code adapter, one Codex adapter) on one node see each other's claims and overlaps in their briefs, and a release records drift against declared paths.
- `ctxd review` shows and resolves each item type listed above.
- Every hook path is proven to exit 0, respect its deadline and make no calls when bypassed.

Then show the owner the output of `ctxd install-hooks --dry-run` for both clients, and stop. Installing for real is the owner's step.

## 5. How to work

- **Plan first.** Read PRD v6, the hooks, claims, context hygiene and memory-and-journal component PRDs, Spec v6 sections 3, 7.5, 7.6, 8.4, 9 and 11, and the M1 code. Then show the owner an M2 slice plan (one branch and one PR per slice, for example `m2/spec-v7`, `m2/hook-core`) and wait for approval before writing code. After approval, work through every slice without stopping for status checks.
- **Definition of done per slice** (AGENTS.md): `/run` while developing, typecheck and tests, `/simplify`, `/verify` end to end, `/code-review` on the diff, then a PR with a summary, the verification run and a short handoff (done, next, open questions).
- **Tests that matter most here:** the conformance kit (exact stdout and exit codes per fixture), deadline and bypass tests, session-file locking under concurrent hooks, and property tests for anything touching events, revert or purge.
- **Spec problems:** do not silently diverge; record them in the PR, and collect them into the next spec version at the end of M2.
