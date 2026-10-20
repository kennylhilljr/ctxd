# ctxd LLD: Claims and Write Intent (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 7.5 |
| **Implements** | [Claims and write intent](../prd/components/PRD-claims-v4.md) (CL-1 to CL-14) |
| **Owner** | A (agent-generated) by persona `component-designer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/claims/`, `src/store/claim.ts` |
| **Moved from** | Spec v9 section 7.5 |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

### 7.5 Claim semantics

Implements [PRD-claims-v4](../prd/components/PRD-claims-v4.md). Claims are events in the task entry's history (`op` `claim` or `release`); the `leases` table is materialized from them.

#### 7.5.1 Write intent normalization

Each pattern in `paths` is validated and normalized without touching the filesystem. Invalid input fails the whole claim with `VALIDATION`.

| Rule | Detail |
|---|---|
| Type and size | Non-empty string, at most 512 bytes; at most 50 patterns per claim |
| Characters | No control characters (U+0000 to U+001F, U+007F) |
| Repository-relative | Reject a leading `/` or `\`, and Windows drive prefixes such as `C:` |
| No escape | Reject any `..` segment |
| No negation | Reject a leading `!` |
| Separators | `\` becomes `/`; empty and `.` segments are removed; trailing `/` is removed |
| Glob syntax | `*` (within a segment), `**` (any depth), `?` (one character). Braces and character classes are rejected in v2 to keep matching predictable |
| Meaning | A pattern without glob characters denotes exactly one file; directories are written as `dir/**` |
| Duplicates | Removed after normalization; the stored list is sorted |
| Omitted vs. empty | `paths` omitted: stored as NULL ("unknown"). `paths: []`: "no file writes" |

#### 7.5.2 Overlap test

Two normalized patterns **may overlap** when:

1. they are identical, or
2. at least one contains a glob character, and their literal prefixes (the segments before the first segment containing a glob character) agree on every segment the two prefixes share.

Two distinct literal paths never overlap. The test is deliberately conservative: it can report overlaps that real files would not produce, but it never misses one. It is a pure function of the two patterns, so every node computes the same result.

Two claims overlap if any pattern pair overlaps. A claim with unknown intent (NULL) is reported as `intent_unknown` alongside overlaps, not as an overlap. A claim with `[]` overlaps nothing.

#### 7.5.3 Claim procedure

`context_claim` with `action: "claim"`:

1. **Normalize** `paths` (7.5.1). Resolve or create the task entry from `task_id` or `title`.
2. **The task is already claimed.** Check the existing lease:
   - **Active, same holder:** renewal. Extend `expires_at`, update `paths` if given, and return the lease.
   - **Active, another holder:** return `CLAIM_HELD` with holder and expiry.
   - **Expired (`now > expires_at`) and `take_over` not set:** return `CLAIM_STALE` with the facts in 7.5.5.
   - **Expired and `take_over: true`:** proceed. The old lease moves to `taken_over`, with `taken_over_by` set.
3. **Overlap check.** Compute overlaps against every other `active` lease in the scope.
4. **Apply the scope's `intent_policy`:**

| Policy | Overlaps found |
|---|---|
| `observe` | Grant; record `claim_overlaps` rows; return `overlaps` |
| `warn` | Grant; record rows; return `overlaps` with the instruction text "Tell the user before proceeding" |
| `strict` | Refuse with `CLAIM_OVERLAP` listing the overlapping claims; nothing is written. The `human` client may override with `take_over: true` |

5. **Record.** Append the claim event, recording `base_head` from the session's latest checkpoint (when known) and `session_ref`.
6. **Return** `{lease, overlaps, intent_unknown}`.

**Renewal by activity.** Any `context_write` or `context_handoff` by the holder whose links or body reference the task id updates `last_activity_hlc`. It does not extend `expires_at`; only an explicit re-claim does.

#### 7.5.4 Release and drift audit

`context_claim` with `action: "release"`, by the holder or the `human` client:

1. **Determine `changed_files`:**
   - **Agent-supplied:** if `changed_files` is given, use it after normalizing each path with the 7.5.1 rules (literal paths only).
   - **Derived from git:** otherwise, use the hook-recorded git facts for the holder's sessions since the claim. That is the union of files in commit pointers recorded by the PostToolUse hook (7.5.6), plus the working-tree changes in the latest PreCompact, Stop or SessionEnd checkpoint, relative to `base_head`.
   - **No git facts:** if neither exists, record `changed_files: null` (unknown).
2. **Compute drift.** If the lease has known `paths` and `changed_files` is known, drift is the set of changed files that match no declared pattern. Matching uses the 7.5.1 glob semantics, anchored to the full path. With unknown intent, no drift is computed and the release notes `intent_unknown`.
3. **Record.** Append the release event, and set state to `released`, `released_at`, `changed_files` and `drift`. Both lists are bounded to 200 paths, with a count of any omitted.
4. **Apply the policy:**
   - **Any drift:** add a notice to the scope's next briefs.
   - **`strict` and non-empty drift:** list the release in `ctxd review` under "Drift."
5. **Never touch the repository.** ctxd does not revert, block or modify files.

**Mechanical release.** When a session ends (SessionEnd for Claude Code, or a Stop hook that sees the session closing for Codex) and the session's client still holds an active lease whose work is committed (`HEAD` changed since `base_head` and the working tree is clean), the hook releases it with derived `changed_files`. Otherwise the lease stays active until it expires. This behavior is configurable per scope (PRD Q9).

#### 7.5.5 Stale-claim facts

`CLAIM_STALE` details include:

| Field | Source |
|---|---|
| `holder`, `claimed_at`, `expired_at` | Lease |
| `last_activity` | Latest event by the holder in the scope (time and kind) |
| `holder_session_state` | Last known state of the holder's session from `sessions` (`active`, `compacting`, `idle`, `ended` or `unknown`) |
| `handoffs_since_claim` | Up to 3 handoffs by the holder since `claim_hlc` (id, title, time) |
| `commits_since_claim` | Up to 10 commit pointers by the holder since `claim_hlc` (sha, subject), read from the local `commits` table (7.5.6) |
| `paths` | The stale claim's write intent |
| `guidance` | "Check whether this work is already done before taking over. Retry with take_over: true to proceed." |

A takeover appends a claim event that references the previous lease's claim event. The previous holder receives a brief notice: "Your claim on <task> was taken over by <client> at <time>."

#### 7.5.6 Commit facts

A local, non-replicated `commits` table (4) records one row per `(sha, scope_id)` for every successful `git commit` the PostToolUse hook observes (9.2): `session_ref`, the commit subject, the JSON array of changed files, the authoring `client_id` and the timestamp. It exists to answer 7.5.4's and 7.5.5's "commits since this claim" questions directly from local state, without replaying the event log or shelling out to git again.

Commit facts and the mechanical `journal` entry 9.2 describes for the same commit are two separate records of the same event, written together by the same hook call: the `commits` row is a query-friendly local cache, and the journal entry (with its `points_to commit:<sha>` link) is the replicated, user-visible record. Writing the hook that populates `commits` and the matching journal entry is M2 work; this revision only adds the table.
