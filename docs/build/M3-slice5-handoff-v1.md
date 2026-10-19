# M3 slice 5 handoff: claims across nodes

Branch `m3/sync-claims`, off `m3/sync-purge` (PR #34, M3 slice 4, not yet merged at the time this
branched). Implements the "Claims across nodes" row of [M3-plan-v1](M3-plan-v1.md#slice-5-claims-across-nodes):
Spec 7.4's claim-conflict policies, 7.5's tentative-claim rule, and the `claim_overlaps` table
left unused since M1/M2.

## What landed

- **Claim events now carry a real parent.** `claim.ts` sets a `claim` event's `parentRevs` to the
  prior active lease's `claim_hlc` for a renewal or take-over, `[]` only for a genuinely fresh
  claim (previously always `[]`). `src/sync/apply.ts`'s `decide` compares that against the task's
  current active `claim_hlc`, the claim part's "head," through the same fast-forward/concurrent
  fork content and status already use, instead of fast-forwarding every claim/release
  unconditionally.
- **Concurrent claims on one task (Spec 7.4)** resolve by earliest `claim_hlc`, via a new
  `applyClaimConflict` in `src/store/materialize.ts` that reuses the existing `resolveConflict`
  shape. The losing claim never becomes active; it is recorded as a lost `entry_siblings` row
  (`part` widened to allow `'claim'`) instead of needing the single `leases` row to represent both
  outcomes.
- **A stale release is a no-op.** A release's `parentRevs` names the exact claim it targets; one
  superseded by a take-over, a newer claim, or an earlier duplicate release is routed through the
  conflict-checking path and found to have nothing left to do, rather than clobbering whatever
  claim is actually active.
- **Write-intent overlaps (Spec 7.4's other row), persisted for the first time.** A new
  `src/claims/overlap.ts` (`scanOverlappingLeases`, `persistOverlaps`) is shared by `claim.ts`'s
  local, synchronous check (origin `claim`) and `materialize.ts`'s replicated path (origin
  `sync`), so `ctxd rebuild` reproduces the same rows a live claim already wrote.
- **Tentative claims.** A claim made while this node has at least one peer and none has completed
  a successful pull in the last 10 minutes is flagged `tentative`; a node with no peers at all is
  exempt. `peers.last_synced_at` (new column) is set by `src/sync/pull.ts` on every completed
  pull.
- **A real bug fixed in `rebuild.ts`:** it hardcoded `parentRevs` to `[]` for every op except
  `update`/`status`, from before claims needed a real parent; this silently broke claim/release
  conflict resolution during a rebuild (every take-over looked fresh, every release looked
  stale). Fixed by adding `claim`/`release` to the ops it parses `parent_revs` for.

## Verification

- `npm run typecheck` / `npm run build`: clean.
- `npm test`: 524/524 (run with `CTXD_BYPASS` unset).
- `test/unit/sync-claims.test.ts` (new): concurrent claims converge to the earliest `claim_hlc`
  regardless of application order, with the loser recorded as a lost sibling; a take-over of an
  expired lease is not mistaken for a race even with a later HLC; a stale release (superseded by
  a take-over, or a duplicate of an already-released claim with no active lease left at all) is a
  no-op, not deferred forever; overlapping write intent across two tasks is recorded in both
  directions with each row's own orientation correct; a rebuild reproduces the same
  `claim_overlaps` rows a local claim already wrote; the tentative flag is on/off exactly per the
  10-minute/no-peers rule.
- `test/unit/claim.test.ts`'s pre-existing rebuild-convergence test (claim, two flags, release)
  continues to pass, now exercising the real `parentRevs` path instead of the always-`[]` one.

## `/simplify` and redesign

The first cut of this slice (concurrent-claim tie-break inlined in the shared trusted/replicated
code path, a separate `origin: "local" | "sync"` option, a release guard keyed off a new payload
field) drew a converged critique from all four parallel reviewers: the right mechanism
(`applyReplicatedEvent`'s existing parentRevs-vs-head conflict check) already existed for
content/status, and claims should extend it rather than bolt on a parallel one. The `origin`
option in particular hid a real divergence: `rebuild.ts` calls `applyReplicatedEvent` without it,
so a historical sync-originated claim's overlaps would never regenerate on rebuild. Rebuilt around
giving claim events a real parent (above); `origin` is gone entirely. See
[M3-plan-v1](M3-plan-v1.md#slice-5-claims-across-nodes) for the full before/after reasoning and
the three deliberately-out-of-scope items (claim-state brief notices, a `strict`-policy review
flag for sync overlaps, and a narrow `claim_overlaps.origin` mislabeling on a from-scratch
rebuild).

## `/code-review`

Five findings on the redesigned diff, all fixed:

1. `persistOverlaps` wrote the same `{mine, theirs}`-oriented pattern pairs into both directions'
   rows, so the reverse row's "mine" named the other task's pattern instead of its own. Fixed by
   swapping orientation for the second row; regression test asserts both rows' orientation with
   two distinct (glob vs. literal) patterns.
2. `decide`'s claim branch returned `"missing-parent"` (deferred forever) for a release whose
   target claim had already left `'active'`, instead of the `"concurrent"` path that already
   no-ops it correctly. Fixed, reasoning from `pull.ts`'s per-origin pull ordering guarantee that
   a release can never genuinely arrive before its own claim, so this case is always "already
   resolved," never "still arriving." Regression test: a duplicate release for an
   already-released claim.
3. The same branch didn't check `op`, so a future `suspend`/`resume` claim event would have been
   misclassified as concurrent (latent: quarantine-driven claim suspension isn't wired up yet).
   Fixed.
4. `applyClaimConflict` recorded the losing claim's `entry_siblings.rev` as an HLC on one side of
   the race and a `makeRev` revision string on the other. Fixed to use the HLC on both sides.
5. The `"deferred"` `Decision` value, and the branch checking for it, were dead code: this slice's
   own redesign removed the only line that ever produced it. Removed.

## Owner steps / open items

- Review and merge PR #34 (slice 4) before this one, then this one before slice 6 branches from
  it.
- Named project scopes still don't share a `scope_id` across nodes (slice 6).
- See "Deliberately out of scope" in M3-plan-v1's slice 5 section for the three named gaps
  (claim-state brief notices, strict-policy overlap review flag, from-scratch-rebuild origin
  mislabeling).
