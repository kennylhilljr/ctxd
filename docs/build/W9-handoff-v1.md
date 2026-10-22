# W9 handoff v1: sealed pool key rotation

The second of [W7's](W7-plan-v1.md) approved follow-ups (`ctxd pool rekey <pool>`), approved by
the owner on 2026-10-21.

## Commits

- `25a9aa0` `W9 slice 1: ctxd pool rekey, rotating a sealed pool's key`
- this handoff

Branch `done/w9-pool-rekey`, based on `main` after W1 to W7 had all merged, so it needs nothing
else first.

## Delivered

**`ctxd pool rekey <pool> [--yes]`**, behind the new `sealed_pools.rekey` flag (off by default:
re-encrypting a live database is risky, and AGENTS.md says risky features ship switched off).
This is the operation [W2's design](../lld/LLD-security-access-v1.md) explicitly named and
deferred, for the one case key transfer does not cover: a pool key a since-revoked node already
holds.

**What rotation does** (`SealedPoolStore.rekey`): generates a fresh 32-byte key, re-encrypts the
pool's own database file under it (SQLCipher's `PRAGMA rekey`, through the same injected database
provider `open` already uses, so tests drive the identical lifecycle against the test provider),
commits the new key, and reports which *other* nodes held the old one.

**Step order is the design**, because exactly one step cannot be undone:

1. stage the new key under `<poolId>.rekey-pending`;
2. re-encrypt the file (**irreversible**);
3. promote the new key to `<poolId>`;
4. drop the staging copy.

A crash between 2 and 3 leaves a file on the new key while `<poolId>` still holds the old one, so
the pool will not unlock; the staging entry is the recovery path and the thrown error names it
rather than leaving you to guess. Staging *before* step 2 is the only reason that window is
recoverable. A failure in step 2 itself drops the staging copy, since the old key is still right.
Both paths are tested.

**Other nodes lose access by one event each.** Rotation does not re-wrap the new key for the
remaining enrolled nodes: that needs each one's prekey and your approval per node, which is
exactly W2's transfer flow, and doing it silently here would hand out a pool key without the
confirmation step W2 exists to provide. Each other node instead gets a `pool_unenroll` acl event
(new: the inverse of `pool_enroll`, sharing its HLC guard target `pool_enrollment:<pool>:<node>`,
so an enroll and an unenroll for the same node converge on whichever carries the later HLC rather
than on arrival order). `servePull`'s existing `pool_enrollments` check then stops serving that
node this pool's sealed events until it re-enrolls. The store deletes no rows itself: materialized
access state only ever changes through an event (ADR 0002).

**Preview by default.** Without `--yes` the command prints which nodes would lose access and the
backup warning, and changes nothing, matching `ctxd scope rollback`'s own preview-first shape. It
also refuses a pool that is not sealed, in the CLI as well as in the store, so a preview never
prints a confident plan for a pool with no key to rotate.

Docs follow the new L3/L4 split this repository moved to while W7 was open: `PA-20` and
`PA-AC-13` in [PRD-pools-access-v3](../prd/components/PRD-pools-access-v3.md), the design in
[LLD section 10.6.2](../lld/LLD-security-access-v1.md), the command in the
[CLI contract](../contracts/cli-reference-v1.md), and a `PA-AC-13` row in the
[test plan](../test/test-plan-v1.md) (counts updated 89 to 90, Covered 39 to 40), per that plan's
own rule that a new criterion gets its row in the same change.

## Verification

`npm run typecheck` and `npm test`: 850 of 850 tests passing across 80 files (9 new, in
`test/unit/sealed-rekey.test.ts`): refusing an unsealed pool without touching the key,
re-encrypting under a fresh key that is exactly the key then committed, still unlocking
afterwards with the rotated key, reporting other nodes but never this one while deleting no rows,
keeping the old key in place when re-encryption fails, naming the staging id when the commit
fails after re-encryption, and four `pool_unenroll` cases including both HLC-guard directions (a
late older enroll never resurrects a rotated-out node, and a genuinely later enroll still
re-enrolls it).

Live, against a scratch `ctxd init` instance: refusal with `sealed_pools` off, refusal for a
pool that is not sealed, `rekey` present in the subcommand usage line, and the full preview output
naming a second enrolled node and changing nothing.

## What was not done and why

- **A real rotation was never run**, because that needs `ctxd-keyhelper` (not yet built, and its
  Touch ID path is your step, same as W2's). The rotation logic is tested against the test key and
  database providers; what is untested is only SQLCipher's own `PRAGMA rekey` against a real
  encrypted file. **Rehearse it on a scratch pool before a real one.**
- **Old backups are not migrated or re-wrapped.** A backup taken before a rotation is ciphertext
  under the old key, and rotation does not keep that key. The command warns on every run and in
  the preview, but if you need those backups readable, export or restore them *before* rotating,
  or keep the old key yourself. Automating that would mean storing superseded keys, which defeats
  the point of rotating after a compromise; it is deliberately your decision, not a default.
- **No automatic rotation triggers.** `ctxd node revoke` does not rotate, and D3's recorded
  decision ("no re-key on revocation") still stands as the default; this only makes rotation
  possible when you decide you want it.

## Owner steps

1. Review `PA-20`/`PA-AC-13` at your Gate 1, since I drafted them rather than decided them.
2. Turn on `sealed_pools.rekey` only when you want to rotate; leave it off otherwise.
3. Rehearse on a scratch sealed pool once `ctxd-keyhelper` exists, before rotating a real one.
4. After rotating, re-enroll each other node with `ctxd pool enroll <pool> <node>`.
