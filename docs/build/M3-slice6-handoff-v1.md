# M3 slice 6 handoff: ACL and scope metadata as events

Branch `m3/sync-acl-events`, off `m3/sync-claims` (PR #38, M3 slice 5, not yet merged at the time
this branched). Implements the "ACL and scope metadata as events" row of
[M3-plan-v1](M3-plan-v1.md#slice-6-acl-and-scope-metadata-as-events): Spec v8 4's `acl` events,
closing the M2 handoff gap where grants, pool changes and review rules never replicated at all,
and the slice-2 gap where named project scopes didn't share a `scope_id` across nodes.

## What landed

- **`ctxd grant`, every mutating `ctxd pool` subcommand, and `ctxd review --add-rule`/
  `--remove-rule` now write through the event path** (one shared `appendAclEvent`,
  `src/store/acl.ts`) instead of directly to `client_grants`/`pools`/`pool_grants`/
  `pool_members`/`scopes.review_policy`, which never replicated before this slice.
- **Scope and pool ids are now derived from their names** (`core/ids.ts`'s `deterministicId`),
  not random, so two nodes creating "the same" scope or pool while partitioned converge on one id
  without ever syncing first, closing the gap slice 2 named.
- **The reserved `_system` scope** carries every `acl` event's own `scope_id` (never the entity's
  own id), so the replication filter (`src/sync/pull.ts`) has a real row to find even for a
  brand-new scope or pool. Created the same genesis-exception way `_me` is.
- **An HLC guard (`acl_cursors`, `aclGuardPasses`) backs every mutating acl action** (grants,
  membership, review policy, and scope/pool creation's own declared fields), so a conflicting
  pair applied out of causal order converges on whichever is actually later, not on arrival
  order.

## Verification

- `npm run typecheck` / `npm run build`: clean.
- `npm test`: 538/538 (run with `CTXD_BYPASS` unset).
- `test/unit/sync-acl.test.ts` (new): deterministic ids; each acl action materializes correctly;
  scope/pool creation, grants, membership and review-policy changes all converge on the
  later-HLC outcome in both application orders; an exact HLC tie accepts the second action
  instead of dropping it; a rebuild reproduces the same acl-derived state a live sequence already
  produced.
- `test/unit/access-identity.test.ts`, `test/unit/scope.test.ts`: updated for the new
  `WriteContext`-based signatures; a new regression test confirms `_system` is refused as a pool
  grant target.

## `/simplify`

Four parallel reviewers converged on the same finding: the first cut treated every acl action as
a plain, unconditional upsert, reasoning "last-applied-wins" was an acceptable, narrower
convergence guarantee for human-only, low-frequency operations. All four pushed back, correctly:
`decide` (`src/sync/apply.ts`) fast-forwards every `meta` event unconditionally, so a grant and a
revoke of the same pool+scope applied out of causal order could silently resurrect access a human
explicitly took away. Fixed with the same HLC-guarded-upsert mechanism purge (slice 4) and claims
(slice 5) already use (`acl_cursors`/`aclGuardPasses`, above). Also applied: one shared
`appendAclEvent` replacing four duplicated event-append blocks, and a discriminated `AclPayload`
union replacing seven repeated inline casts in `applyAclEvent`.

## `/code-review`

Seven findings on the fixed diff, all addressed:

1. `scope_create`/`pool_create` were believed to need no guard at all (true for the
   deterministic id, not for the declared fields); fixed to guard and converge replication/
   vendor_policy/description on the later HLC too, with a new regression test.
2. `aclGuardPasses` rejected an exact HLC tie as stale. Since an encoded HLC can only tie between
   two events from the *same* node, this was reachable from two rapid, separate CLI invocations
   whose `HlcClock` each started fresh at the same millisecond, silently dropping the second
   action while the CLI still printed success. Fixed to accept a tie (this node's own transaction
   order is the real causal order regardless of what a tied clock says), with a regression test.
3. `ctxd rebuild` never cleared `pools`/`pool_grants`/`pool_members`/`client_grants`/
   `acl_cursors` before replay, so it could not actually recover from corruption in any of them:
   every replayed acl event was a guard-rejected no-op against the pre-rebuild cursor. Fixed
   (child tables before the parent `pools`, to satisfy the existing foreign keys); `scopes` itself
   is still never wiped, since `_me`/`_system` (and a lazily created `_hold.*` scope,
   `src/store/write.ts`, pre-existing) are genesis rows with no backing event.
4. `ctxd review --add-rule`/`--remove-rule`'s read-modify-write-then-replace-the-whole-array
   model can still lose one side's change when two nodes edit *different* rules for the same
   scope while partitioned, the same failure mode this slice closed for grants and membership by
   modeling them as per-target actions instead. Rules have no stable identity to key a per-rule
   guard on today; documented as a known, narrower gap (M3-plan-v1) rather than redesigning rule
   identity under this slice.
5. `SYSTEM_SCOPE_ID`'s doc comment overclaimed that `vendor_policy: 'local-only'` alone keeps
   `_system` human-only; by itself it only excludes a non-`local`-vendor agent, the same as any
   other `local-only` scope, and nothing stopped `ctxd pool grant <pool> _system write`. Fixed:
   `src/cli/pool.ts`/`src/cli/grant.ts` now refuse to resolve `_system` as a grant target at all,
   with a regression test; the doc comment now describes that as the real enforcement.
6. Double-hyphen dashes in this slice's own new `M3-plan-v1.md` prose, against the repo's writing
   style rule. Fixed.
7. `src/store/acl.ts`'s `nextOriginSeq` duplicated `src/store/write.ts`'s, in the very diff whose
   `/simplify` pass had just consolidated four other duplicates of the same shape. Fixed: the
   latter is now exported and reused.

## Owner steps / open items

- Review and merge PR #38 (slice 5) before this one, then this one before slice 7 branches from
  it.
- See "Deliberately out of scope" in M3-plan-v1's slice 6 section for the three named gaps
  (`_system`'s replication-policy routing, review-policy's read-modify-write resurrection risk,
  `acl` events' hardcoded rev version).
