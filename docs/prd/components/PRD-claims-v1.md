# ctxd Component PRD: Claims and Write Intent (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-17 |
| **Parent** | [ctxd PRD v2](../PRD-v2.md) |
| **Siblings** | [Hooks and agent lifecycle](PRD-hooks-v1.md), [Trust and safety](PRD-trust-safety-v1.md), [Replication](PRD-replication-v1.md), [Briefs and search](PRD-briefs-search-v1.md) |
| **Spec** | [Spec v2](../../spec/SPEC-v2.md) sections 4 (`leases`, `claim_overlaps`), 7.4, 7.5 and 8.2 (`context_claim`) |
| **Parent requirements elaborated** | FR-17, FR-23, FR-24, FR-25, FR-26 |
| **Adapted from** | [coordinate-agents](https://github.com/hogancv/coordinate-agents) (MIT): Intent Map write intent, conservative overlap test, scope audit modes, stale-claim recovery rule. [OpenWork](https://github.com/different-ai/openwork): session activity states |

## 1. Purpose

When several agents work on the same project, they need to know who is doing what and which files each expects to touch. Claims make that visible. This component defines task claims, the write intent attached to them, how overlaps and drift are detected, and how an abandoned claim is safely taken over.

Claims are **coordination information, not enforcement**. ctxd never blocks an editor, reverts a file or changes a repository. It tells agents (and me) about collisions early enough to avoid them.

## 2. Scope

**In scope:**

- claiming, renewing, releasing and listing tasks;
- write intent on claims;
- overlap detection under a per-scope policy;
- the drift audit on release;
- stale-claim takeover;
- claims across machines.

**Out of scope:**

- **Task planning and dependency graphs.** Task entries exist, but planning stays with me or an external tracker (parent Q6 considers Beads).
- **Running agents, worktrees and merge orchestration.** That is the job of tools like coordinate-agents (parent Appendix B).
- **Locking files at the filesystem or git level.**

## 3. Concepts

| Term | Meaning |
|---|---|
| **Claim (lease)** | A time-limited statement that a client is working on a task. Default length 120 minutes; renewed by claiming again |
| **Write intent** | Repository-relative path patterns the claimed work expects to change, such as `src/sync/**`. Omitted means unknown; an empty list means the task writes no files |
| **Overlap** | Two active claims in a scope whose write intent may touch the same file |
| **Intent policy** | Per scope: `observe`, `warn` (default) or `strict` |
| **Drift** | Files changed under a claim that its write intent did not cover |
| **Stale claim** | A claim past its expiry that was never released |
| **Takeover** | Explicitly claiming a stale task after checking the facts |

## 4. Write intent

When an agent claims a task in a repository, it declares the paths it expects to write, for example `["src/sync/**", "test/sync/**"]`. The rules:

- Patterns are repository-relative globs using `*`, `**` and `?`.
- Absolute paths, `..`, negation and control characters are rejected.
- A plain path means exactly that file; use `dir/**` for a directory.
- Omitting `paths` means "unknown." An empty list means "no file writes," such as a research or review task.

Patterns are treated purely as data: they are never run through a shell or resolved on disk.

## 5. Overlap

When a claim's paths may intersect another active claim's paths in the same scope, ctxd applies the scope's intent policy:

| Policy | Effect on the new claim |
|---|---|
| `observe` | Granted. The overlap is recorded and shown in briefs. |
| `warn` (default) | Granted. The claim result lists the overlapping claims, and the agent is instructed to tell me before proceeding. |
| `strict` | Refused with `CLAIM_OVERLAP` until the other claim is released or I override. |

Overlap detection is **conservative**: it may report an overlap that would not actually happen, but it never misses a real one. A claim with unknown intent is shown as "intent unknown" rather than as an overlap, so missing intent stays visible.

Claims made on different machines while disconnected are compared when they sync (see [Replication](PRD-replication-v1.md)). Any overlap appears as a notice in the next brief; nothing already granted is revoked.

## 6. Drift audit

When a claim is released, ctxd compares the files changed under it with the declared paths:

- **Where the changed files come from.** The agent supplies them, or ctxd derives them from the git facts that hooks record during the session (commit file lists and working-tree checkpoints; see [Hooks](PRD-hooks-v1.md) HK-10).
- **What happens with drift.** Files outside the declared paths are recorded on the release, shown in the next brief, and listed in `ctxd review`. Under `strict`, the release is also flagged for my review.
- **What ctxd never does.** It never reverts, blocks or modifies anything in the repository. Drift is information, not enforcement.

**Mechanical release.** If a session ends while its client still holds a claim whose work is committed (HEAD moved and the working tree is clean), the session-end hook releases the claim with derived changed files. Otherwise the claim stays until it expires.

## 7. Stale claims: facts before takeover

A claim that passes its expiry is never silently handed to someone else. When another client tries to claim it, ctxd returns `CLAIM_STALE` with the facts:

- who held it, when they claimed it and when it expired;
- their last activity in the scope, and the holder session's last known state (active, compacting, idle or ended, as reported by hooks), which separates a blocked session from an abandoned one;
- any handoffs and commit pointers they recorded since the claim;
- the claim's declared paths.

The new agent must look at those facts (has the work actually been done?) and pass `take_over: true` to proceed. The takeover is recorded, and the previous holder sees it in its next brief.

## 8. Scenarios

1. **No collision.** Claude holds "push path cleanup" on `src/sync/**`. Codex claims "conflict tests" on `test/sync/**`. There is no overlap, so both proceed.
2. **Collision caught.** Claude then claims "tidy fixtures" on `test/sync/fixtures.ts`. Under `warn`, the claim is granted with an overlap listing Codex's claim, and Claude tells me before editing.
3. **Strict project.** In a scope set to `strict`, the same claim is refused with `CLAIM_OVERLAP`. I either wait or override from the CLI.
4. **Drift.** Codex releases "conflict tests"; its commits also touched `src/sync/apply.ts`. The release records that file as drift, and the next brief shows it.
5. **Abandoned work.** A session died holding "FTS ranking." Two hours later, Claude tries to claim it and gets `CLAIM_STALE`, showing one commit and no handoff since the claim. Claude reviews the commit, tells me, and takes over.
6. **Offline overlap.** On the train, Codex claims `src/brief/**` on the laptop; at home, Claude Code on the Air claims `src/brief/assemble.ts`. When the laptop syncs, both see an overlap notice.

## 9. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| CL-1 | Claim, renew, release and list tasks through `context_claim`; a task can be created by title when claimed | FR-17 | P1 |
| CL-2 | Claims accept optional write intent, validated and normalized per section 4; invalid patterns reject the whole claim | FR-23 | P1 |
| CL-3 | Overlap detection is deterministic, symmetric and conservative (never misses a true overlap) | FR-24 | P1 |
| CL-4 | Intent policy per scope (`observe`, `warn` default, `strict`) governs the claim result | FR-24 | P1 |
| CL-5 | Overlaps found during sync are recorded and briefed; no granted claim is revoked automatically | FR-24 | P1 |
| CL-6 | Release computes changed files (supplied or derived from hook-recorded git facts) and drift against write intent | FR-25 | P1 |
| CL-7 | Drift is recorded, briefed and listed in review; under `strict` it is flagged for review | FR-25 | P1 |
| CL-8 | Expired claims return `CLAIM_STALE` with bounded facts; reclaim requires `take_over: true`; takeovers are recorded and briefed | FR-26 | P1 |
| CL-9 | Concurrent claims on the same task across machines resolve deterministically (earliest claim wins; loser notified) | FR-17 | P1 |
| CL-10 | Briefs show open claims with holder, age, write intent (or "unknown") and any overlaps | [Briefs and search](PRD-briefs-search-v1.md) | P1 |
| CL-11 | `ctxd claims` lists claims; `ctxd scope set --intent-policy` changes a scope's policy | FR-17 | P1 |
| CL-12 | Hooks report the holder session's state (active, compacting, idle, ended); it is shown with claims and in stale-claim facts | FR-26 | P1 |

## 10. Acceptance criteria

- Two agents on one Mac claiming overlapping paths see the overlap in the claim result and in the next brief.
- A strict scope refuses the overlapping claim, and the CLI can override it.
- Releasing a claim after editing a file outside its paths records exactly that file as drift.
- A stale claim cannot be taken over without `take_over: true`, and the facts returned match the holder's recorded activity.
- After a partition heals, both machines report identical claims and overlap notices.

## 11. Open questions

| # | Question |
|---|---|
| CQ-1 | Default lease length and whether a clean session end should auto-release (parent Q9) |
| CQ-2 | Support braces and character classes in patterns later (Spec open issue 6) |
| CQ-3 | Reliable session-closing signal for Codex mechanical release (Spec open issue 7) |
| CQ-4 | Should `warn` overlaps also trigger a desktop notification? |
