# ctxd Component PRD: Claims and Write Intent (v4)

| | |
|---|---|
| **Status** | Draft v4 |
| **Date** | 2026-10-20 |
| **Supersedes** | [v3](PRD-claims-v3.md) |
| **Parent** | [ctxd PRD v8](../PRD-v8.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v4.md), [Persona pools and access](PRD-pools-access-v3.md), [Hooks and agent lifecycle](PRD-hooks-v6.md), [Trust and safety](PRD-trust-safety-v5.md), [Context hygiene](PRD-context-hygiene-v2.md), [Replication](PRD-replication-v6.md), [Briefs and search](PRD-briefs-search-v5.md) |
| **Spec** | [Spec v10](../../spec/SPEC-v10.md) (HLD) sections 4, 7.4, 7.5 and 8.2 (`context_claim`); detail in [LLD: Claims](../../lld/LLD-claims-v1.md) |
| **Acceptance tests** | [Test plan v1](../../test/test-plan-v1.md), CL section |
| **Parent requirements elaborated** | FR-17, FR-23, FR-24, FR-25, FR-26 |
| **Adapted from** | [coordinate-agents](https://github.com/hogancv/coordinate-agents) (MIT): Intent Map write intent, conservative overlap test, scope audit modes, stale-claim recovery rule. [OpenWork](https://github.com/different-ai/openwork): session activity states |

## Changes in v4

Earlier changes are listed in [v3](PRD-claims-v3.md) and before.

- **Acceptance criteria in EARS, with IDs.** Every criterion is now one EARS statement with an ID (`CL-AC-n`) and the component requirements it verifies. The meaning of each v3 criterion is unchanged; compound criteria were split so each states one response, and criteria the spec's test table already assumed were made explicit. Each ID is mapped to its tests, or marked as a gap, in the [test plan](../../test/test-plan-v1.md).
- **Links.** The header points to PRD v8, Spec v10 (now the system HLD) and this component's LLD; sibling links point to current versions.

## 1. Purpose

When several agents work on the same project, they need to know who is doing what and which files each expects to touch. Claims make that visible. This component defines task claims, the write intent attached to them, how overlaps and drift are detected, and how an abandoned claim is safely taken over.

Only agents with `propose` or `write` access to a scope through their persona pools can claim its tasks ([Persona pools and access](PRD-pools-access-v3.md)); overlap notices are shown only to agents that can read both scopes.

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

The claim is stored as its own part of the task entry, versioned separately from the task's content.

## 4. Write intent

When an agent claims a task in a repository, it declares the paths it expects to write, for example `["src/sync/**", "test/sync/**"]`. The rules:

- Patterns are repository-relative globs using `*`, `**` and `?`.
- Absolute paths, `..`, negation and control characters are rejected.
- A plain path means exactly that file; use `dir/**` for a directory.
- Omitting `paths` means "unknown." An empty list means "no file writes," such as a research or review task.

Patterns are treated purely as data: they are never run through a shell or resolved on disk.

### 4.1 What the work implements

A task can carry an `implements` relation to the decision or convention it carries out. If that decision is superseded while the task is claimed, the holder's next brief says so, before the work drifts from what was decided.

## 5. Overlap

When a claim's paths may intersect another active claim's paths in the same scope, ctxd applies the scope's intent policy:

| Policy | Effect on the new claim |
|---|---|
| `observe` | Granted. The overlap is recorded and shown in briefs. |
| `warn` (default) | Granted. The claim result lists the overlapping claims, and the agent is instructed to tell me before proceeding. |
| `strict` | Refused with `CLAIM_OVERLAP` until the other claim is released or I override. |

Overlap detection is **conservative**: it may report an overlap that would not actually happen, but it never misses a real one. A claim with unknown intent is shown as "intent unknown" rather than as an overlap, so missing intent stays visible.

Claims made on different machines while disconnected are compared when they sync (see [Replication](PRD-replication-v6.md)). Any overlap appears as a notice in the next brief; nothing already granted is revoked.

## 6. Drift audit

When a claim is released, ctxd compares the files changed under it with the declared paths:

- **Where the changed files come from.** The agent supplies them, or ctxd derives them from the git facts that hooks record during the session (commit file lists and working-tree checkpoints; see [Hooks](PRD-hooks-v6.md) HK-10).
- **What happens with drift.** Files outside the declared paths are recorded on the release, shown in the next brief, and listed in `ctxd review`. Under `strict`, the release is also flagged for my review.
- **What ctxd never does.** It never reverts, blocks or modifies anything in the repository. Drift is information, not enforcement.

**Quarantine.** When an agent's work is quarantined ([Context hygiene](PRD-context-hygiene-v2.md) section 4), its active claims in the batch's scopes are suspended: they no longer block other agents, and they are released if the batch is reverted.

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
| CL-10 | Briefs show open claims with holder, age, write intent (or "unknown") and any overlaps | [Briefs and search](PRD-briefs-search-v5.md) | P1 |
| CL-11 | `ctxd claims` lists claims; `ctxd scope set --intent-policy` changes a scope's policy | FR-17 | P1 |
| CL-12 | Hooks report the holder session's state (active, compacting, idle, ended); it is shown with claims and in stale-claim facts | FR-26 | P1 |
| CL-13 | When a claimed task's `implements` target is superseded, the holder is notified in its next brief | FR-31 | P2 |
| CL-14 | Claims are an independently versioned part of the task entry | FR-3 | P1 |

## 10. Acceptance criteria

> Owner: A (agent-generated) by persona `product-writer`, derived from the requirements above; approved by the owner at Gate 1. Verification status per criterion: [test plan](../../test/test-plan-v1.md).

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| CL-AC-1 | Event-driven | When two agents claim tasks with overlapping write intent in a `warn` scope, ctxd shall grant both claims and return the overlap in the second claim's result and in the next brief. | CL-3, CL-4, CL-10 |
| CL-AC-2 | Unwanted behavior | If a claim's write intent overlaps an active claim in a `strict` scope, then ctxd shall refuse it with `CLAIM_OVERLAP` and write nothing. | CL-4 |
| CL-AC-3 | Event-driven | When the human client claims with `take_over: true` in a `strict` scope, ctxd shall grant the claim despite the overlap. | CL-4 |
| CL-AC-4 | Event-driven | When a claim is released after the holder changed a file outside its declared paths, ctxd shall record exactly that file as drift. | CL-6, CL-7 |
| CL-AC-5 | Unwanted behavior | If a claim targets a task whose lease has expired and `take_over` is not set, then ctxd shall return `CLAIM_STALE` with facts that match the holder's recorded activity. | CL-8, CL-12 |
| CL-AC-6 | Event-driven | When a partition heals, every node shall report identical claims and overlap records. | CL-5, CL-9 |

## 11. Open questions

| # | Question |
|---|---|
| CQ-1 | Default lease length and whether a clean session end should auto-release (parent Q9) |
| CQ-2 | Support braces and character classes in patterns later (Spec open issue 6) |
| CQ-3 | Reliable session-closing signal for Codex mechanical release (Spec open issue 7) |
| CQ-4 | Should `warn` overlaps also trigger a desktop notification? |
