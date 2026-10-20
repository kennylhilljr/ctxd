# W2 handoff v1

## Commits

- `ca52d97` `W2 slice 1: design sealed pool key transfer`
- `0cf1d88` `W2 slice 2: schema and flag for key transfer`
- `23af005` `W2 slice 3: signed encryption prekeys`
- `857b1d9` `W2 slice 4: key transfer protocol`
- `08c15d0` `W2 slice 5: key transfer over the sync listener`
- `6ceb7ac` `W2 slice 6: ctxd pool enroll and approve-key-transfer`
- `4ec5cbe` `W2 slice 7: real HTTP coverage for key transfer`
- `29294c3` `W2 slice 8: prove the recipient actually unlocks`

Branch `done/w2-sealed-key-transfer`, eight commits on top of `main`. Nothing was pushed and no pull request was opened; that is the owner's step per the kickoff plan.

## Delivered

**The design** (slice 1, in [docs/spec/SPEC-v10-draft.md](../spec/SPEC-v10.md)'s "W2: sealed pool key transfer" section) covers every point the kickoff plan asked for: a recipient's encryption key bound to its already-enrolled signing identity, the owner's explicit approval on the source, a confirmation code shown on both nodes without transmitting it, replay protection, and what revoking a node does. It does not contradict Spec 10.6, which already describes the key as "copied once ... over the tailnet with my approval on both machines"; this fills in how.

**Every node gets a long-lived, signed X25519 encryption keypair** (`node_encryption_keys`, schema v21), separate from its Ed25519 event-signing identity but bound to it: the prekey is signed with the node's own Ed25519 private key, so a peer that already trusts that node's Ed25519 identity (`peers.remote_public_key`, pinned at enrollment, M6) can verify the prekey actually belongs to it. The private key lives in a PEM file beside the Ed25519 identity file, never in the database, mirroring `FileEventKeyProvider` exactly.

**The transfer protocol** (`src/sealed/keyTransfer.ts`): `requestKeyTransfer` (source side, verifies the requester's trust and pins its prekey), `approveKeyTransfer` (source side, owner-only by construction — it is never reachable except from this CLI command — wraps the real key via an ECDH-derived key), `fetchWrappedKey` (source side, one-time-use: the replay protection), `completeKeyTransfer` (recipient side, unwraps and returns the key for the caller to install). The confirmation code is derived from the same ECDH shared secret on both sides, independently, never transmitted alongside the wrapped key.

**`POST /v1/key-transfer/request` and `POST /v1/key-transfer/fetch`** on the existing peer-authenticated sync listener (`src/server/sync.ts`), gated behind the new `sealed_pools.key_transfer` flag (off by default); 404 when it is off. Approval itself never travels over this channel.

**`ctxd pool enroll <pool> <node>`** (run on the recipient) now does real work instead of throwing: the first call requests a transfer and prints a confirmation code immediately (both sides can derive it as soon as both prekeys are known, independent of approval timing); after the owner runs **`ctxd pool approve-key-transfer <transferId>`** on the source (which prints the same code), a second call with `--transfer-id <id>` fetches, unwraps, installs the key via `SealedPoolStore.enroll` (which also records `pool_enrollments`), and emits the same `pool_enroll` acl event `ctxd pool seal` already uses for the sealing node itself.

**`SealedKeyProvider`** gained `store(poolId, key)` (both `TestKeyProvider` and `KeyHelperProvider`), since a transfer recipient installs a *received* key rather than always generating a fresh one.

**Revoking a node:** at minimum, no new keys — a revoked peer fails the trust check at request time, so it can never start or complete a new transfer. Existing sealed pools are **not** re-keyed on revocation; a pool key a since-revoked node already holds stays valid for whatever it already has. A future `ctxd pool rekey <pool>` is the place for that, not built here.

Spec changes are in [docs/spec/SPEC-v10-draft.md](../spec/SPEC-v10.md), which M7 slice 8 folds into the numbered Spec v10.

## Verification

`npm run typecheck` and `npm test`: 779 of 779 tests passing across 69 files, built against the test key provider throughout, as the kickoff plan specifies.

- `test/unit/sealed-encryption-keys.test.ts`: the signed-prekey primitives in isolation — keypair persistence, signature verification (including a forged-signature rejection), prekey pinning (including a changed-key rejection), and that both sides of an ECDH exchange derive the same wrap key and confirmation code.
- `test/unit/sealed-key-transfer.test.ts`: the full protocol with two local node databases — the happy path, and every refusal path: an unknown node, a revoked peer, a forged prekey signature, fetching before approval, an unknown transfer id, a replayed fetch, an expired transfer, and a non-sealed pool.
- `test/unit/sealed-key-transfer-http.test.ts`: the same protocol over a real HTTP listener (`startSyncServer`) — the flag-off 404, and a full request/fetch round trip including the pre-approval refusal and the replay refusal over the wire.
- `test/unit/sealed.test.ts`: `SealedPoolStore.enroll`'s own behavior (refuses a non-sealed pool, installs a received key and records the enrollment once actually sealed), and — the literal exit criterion — a second local node that cannot `unlock()` a sealed pool it already has the file for until `enroll()` installs the key, and then can.
- `test/unit/sealed.test.ts`'s pre-existing property and conflict tests are unchanged and still pass.

## What was not done and why

Nothing from W2's scope was skipped. Two things are explicitly deferred, by the kickoff plan's own instruction and this design's own stated limits:

- **The real Keychain/Touch ID path** (`ctxd-keyhelper`) is the owner's step (kickoff section 3 step 5); this slice builds and tests against the test key provider throughout, as instructed. `KeyHelperProvider.store` shells out to a `store` action the real `ctxd-keyhelper` binary does not yet implement; that binary's own build is a separate, already-tracked piece of work ([ctxd-keyhelper-build-v1.md](ctxd-keyhelper-build-v1.md)), not rebuilt here.
- **Re-keying a pool on node revocation** is explicitly out of scope, per the kickoff plan's own "at minimum: no new keys" phrasing; see "Revoking a node" above.

## Owner steps

- Merge this branch (owner's step, per the kickoff plan's section 0).
- This branch bumps `SCHEMA_VERSION` to 21, built from `main` before any of the other open workstream PRs (W3/W4/W5/W6) had merged into it. Whichever of these PRs merges after another that also touched the schema needs its migration renumbered first, per the kickoff plan's own anticipated rule.
- Rehearsing the real key transfer on real hardware (kickoff section 3 step 6, alongside the hub migration runbook) is the owner's step once `ctxd-keyhelper` is built and Touch ID is available.
