# Spec v10 draft

Working notes collected while the completion kickoff ([docs/build/completion-kickoff-v1.md](../build/completion-kickoff-v1.md)) runs. M7 slice 8 folds this into the numbered Spec v10; until then each workstream appends its own section here instead of editing Spec v9 directly.

## W5: correctness gaps

### W5.1 Approval timestamps

Closes a gap Spec v9's own schema left open: `entries.approved_by` and `entries.approved_hlc` are now set whenever an entry is actually approved, not left NULL forever.

- Set on the review path: `ctxd review --approve` (the `resolve` status event) records the approving human client and the resolve event's HLC.
- Set at creation for an auto-accept review rule match (10.4): the creating client and the create event's HLC, since the rule itself is the approval.
- Left NULL for a write that was never under review at all: the human client writing directly, or a kind whose unreviewed default status is already `active`. There was no approval step to record.
- The weekly digest's "decisions made" section (11.5) now reads `approved_hlc`, falling back to `created_hlc` for a decision that was active from creation and so never had a separate approval moment.

### W5.2 Crash sweep: mechanical release and journal entry

Closes the gap 9.10 already described but the implementation had not reached: a session that crashes without ever calling SessionEnd leaves no ticket behind, so the crash sweep had no `cwd` to check "is the working tree clean" against.

- `sessions.cwd` (schema v20) is recorded once, at SessionStart, and kept for that session's life; a later event's reported `cwd` never overwrites it.
- The crash sweep now runs the same mechanical journal entry and claim release a real SessionEnd runs (`performSessionEnd`), for a finalized session that has a recorded `cwd` and scope, gated behind `claims.mechanical_release` (the same flag that already gates live SessionEnd's release).
- A session with no recorded `cwd` (a row from before this slice) or no scope is only finalized, exactly as before this slice.

### W5.3 List mode ordering

Fixes a bug against Spec v9's own 11.2: "With `query: '*'` and a time filter, results are listed newest first instead of by relevance." The implementation listed by time at the SQL level, but then re-sorted the results by a score that, in list mode, was the entry's importance, whatever the `importance` flag said.

- List mode (`query: "*"`) now lists strictly by time in both `importance` flag states: every list-mode row gets `_score = 0`, so the final stable sort leaves the SQL's own time-descending order alone.
- The scope fan-out multipliers (0.9/0.8/1.0, 11.2) and the flagged-entry penalty are relevance adjustments; they apply only to scored (non-`"*"`) search, never to list mode.

### W5.4 Automatic skill sync

Implements the deferred half of 12.2: previously, writing or approving a skill never updated the client skill folder until the next manual `ctxd skills sync`.

- A write to a skill entry (`context_write`), and an approval of a proposed skill (`ctxd review --approve`), now schedule a sync when `skills.native_sync` is on, through the same ticket-plus-detached-worker mechanism SessionEnd uses (9.7): a `skill-sync` ticket under `sessions/`, picked up by `ctxd worker` or, if left behind, the next crash sweep.
- The actual folder write never runs inline in the write path or inside a hook's time budget; disk I/O for every configured client has no place on the critical path of an unrelated tool call.
- The trigger fires on the entry's kind alone, not on its resulting status: scheduling a sync for a write that leaves the skill `proposed` is harmless, since the sync itself only ever selects `active` skills.
- A no-op, not an error, if `skills.native_sync` has been turned off by the time the worker actually runs.

### W5.5 Codex's skills folder confirmed

Closes open issue 16 (12.2): Codex's personal skills folder is `~/.agents/skills` (`$HOME/.agents/skills`), confirmed directly from the `openai/codex` source at the pinned minimum version (`rust-v0.145.0`): `codex-rs/core-skills/src/loader.rs` resolves the user-scoped skill root as `home_dir.join(".agents").join("skills")`. SKILL.md there needs just `name` and `description` frontmatter, matching ctxd's own requirement exactly, so no format change was needed.

A deprecated `$CODEX_HOME/skills` fallback is also still scanned by Codex itself for backward compatibility; ctxd writes only to the current location.

`ctxd skills sync --client codex` and `ctxd skills import --from codex` both now work; `clientSkillsDir("codex", ...)` no longer returns null. See [PRD-skills-v2.md](../prd/components/PRD-skills-v2.md).

### W5 accepted limitation: PreCompact's phase and summary

No work, by design: PreCompact still writes only the mechanical checkpoint file (branch, HEAD, changed files). Recording "phase and last request summary from the hook input" (9.2) has no reliable source, since neither Claude Code's nor Codex's documented PreCompact payload carries one, only `session_id`/`cwd`/`trigger`. Revisit only if a client adds such a field.

## W2: sealed pool key transfer (design)

10.6 already says an enrolled node's key is "copied once ... over the tailnet with my approval on both machines," but no authenticated mechanism existed: `SealedPoolStore.enroll` unconditionally threw "remote sealed key transfer is not implemented." This section designs that mechanism; it does not contradict 10.6, it fills in the "copied" step 10.6 already assumed. Built against the test key provider (W2 slices 2+); the real Keychain/Touch ID path is the owner's step (kickoff section 3 step 6).

**Every node has a long-lived, signed X25519 encryption keypair** (`node_encryption_keys`), separate from its Ed25519 event-signing identity (`node_keys`, M6). Generated lazily, once, the same way `FileEventKeyProvider` generates the Ed25519 identity: a PEM file beside `node.ed25519.pem`. The encryption public key is signed with the node's own Ed25519 private key (`sign(nodeId || encPublicKey)`), so a peer that already trusts this node's Ed25519 identity (via `peers.remote_public_key`, pinned at enrollment, M6) can verify the encryption key actually belongs to it, not to whoever answers on the wire. This is the "recipient's encryption key, bound to its already enrolled signing identity" the kickoff plan asks for, and it is symmetric: the source node signs and presents its own encryption key the same way, since the wrap step below is a Diffie-Hellman exchange, not one-sided.

**The transfer, over the existing sync channel** (two new POST endpoints on the existing peer-authenticated sync listener, `src/server/sync.ts`, never a new listener):

1. The recipient (the new node) calls `POST /v1/key-transfer/request` on the source (the node currently holding the key): `{pool, nodeId, encPublicKey, signature}`. The source verifies the signature against the recipient's already-pinned Ed25519 key and that the recipient is an un-revoked peer; it refuses otherwise. On success it creates a `sealed_key_transfers` row, status `pending`, with a short expiry (10 minutes).
2. **The owner's explicit approval, on the source node:** `ctxd pool approve-key-transfer <transferId>` is a human-only, local command; nothing above this line can move to `approved` without it. Approving computes the ECDH shared secret (`DH(source's X25519 private key, recipient's X25519 public key)`), derives a transfer key via HKDF, and wraps the pool's raw key with it (`encryptSealed`, the pool-event cipher, reused rather than reinvented, with the transfer id as associated data so a wrapped key can never be replayed against a different transfer).
3. **The confirmation code is derived from the same shared secret** (HKDF with a distinct context, truncated to 6 digits), not transmitted. Approving prints it on the source; the recipient's own completion step independently computes and prints the same digits from its side of the same ECDH exchange before it ever installs the key, so the owner compares the two screens, same intent as a Signal-style safety number, sized for a one-time two-device check rather than a standing identity comparison.
4. The recipient calls `POST /v1/key-transfer/fetch` with `transferId`. The source returns the wrapped key only when status is `approved` and `fetched_at` is still null, and marks `fetched_at` immediately in the same transaction — **the one-time-use rule that is this design's replay protection**: a captured or retried fetch request gets refused once consumed, a request replayed after its own expiry gets refused by the expiry check, and a request from a node that was since revoked gets refused by the revocation check, independent of either.
5. The recipient derives the same ECDH shared secret from its side, unwraps the key, confirms the code matches what the owner saw on the source, then calls its own `SealedKeyProvider.create(poolId)` and records `pool_enrollments` plus the `pool_enroll` acl event exactly as `ctxd pool seal` already does locally today.

**Refusal paths**, every one surfaced as a specific error rather than a generic failure: no approval yet (`fetch` before `approve`), wrong or already-used `transferId`, an expired pending request, a revoked or unknown requesting node (checked at request time, not just at approval), and a replayed fetch after the transfer is already consumed.

**Revoking a node:** at minimum, no new keys. A revoked node's peer record fails the un-revoked check at request time, so it can never start or complete a new transfer. **Existing sealed pools are not re-keyed** on revocation: a pool key a since-revoked node already received stays valid for whatever that node already holds, since rotating a pool's key and redistributing it to every other enrolled node is a materially heavier operation (decrypt and re-encrypt the sealed file, re-wrap for every remaining node) that this slice does not build. A future `ctxd pool rekey <pool>` is the place for that, not assumed here.

**Flag:** `sealed_pools.key_transfer`, off by default, gating both the new endpoints and the CLI commands; `ctxd pool enroll` keeps refusing outright when it is off, same as today.

