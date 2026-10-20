# ctxd LLD: Security and Access (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 10 (the threat model, 10.1, stays in the HLD) |
| **Implements** | [Trust and safety](../prd/components/PRD-trust-safety-v5.md) (TS-1 to TS-17, access and safety requirements), [Persona pools and access](../prd/components/PRD-pools-access-v3.md) (PA-1 to PA-19) |
| **Owner** | A (agent-generated) by persona `security-reviewer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/security/`, `src/access/`, `src/sealed/` |
| **Moved from** | Spec v9 sections 10.2 to 10.7; Spec v10 draft W2 (sealed pool key transfer) |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 10. Security

The threat model (10.1) is system-level and stays in [Spec v10](../spec/SPEC-v10.md) section 10.1.

### 10.2 Tailscale exposure

```bash
# expose only the sync listener, tailnet-only (verify exact syntax for the installed version)
tailscale serve --bg --https=443 --set-path=/ctxd-sync http://127.0.0.1:7412
# never use: tailscale funnel
```

ACL intent: only my own devices (tag `tag:ctxd-node`) may reach port 443 on other `tag:ctxd-node` devices.

### 10.3 Secret detectors

Detectors run at step 4 of the pipeline (6.1). Agent writes are rejected on a match; mechanical hook captures replace the matched span with `[REDACTED]`.

| Detector | Matches |
|---|---|
| `aws-access-key-id` | `AKIA` or `ASIA` followed by 16 uppercase alphanumerics |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` tokens; `github_pat_` tokens |
| `slack-token` | `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxs-` tokens |
| `anthropic-api-key` | `sk-ant-` keys |
| `openai-api-key` | `sk-` and `sk-proj-` keys |
| `private-key-block` | PEM `BEGIN ... PRIVATE KEY` blocks (redaction covers through the matching END line, or to end of text) |
| `jwt` | Three base64url segments beginning `eyJ` |
| `authorization-header` | `Authorization:` or `authorization=` values, with or without `Bearer` or `Basic` |
| `bearer-token` | `Bearer <token>` anywhere |
| `cookie` | `Cookie:` and `Set-Cookie:` values |
| `url-credentials` | `scheme://user:password@host` userinfo |
| `generic-secret-assignment` | Assignments to names containing `password`, `passwd`, `secret`, `token`, `api_key` or `apikey`, `credential`, or `cookie`, with a value of 8 or more characters |

Detectors are a pluggable list, and each has positive and negative test cases. False positives can be overridden only by the `human` client.

### 10.4 Review rules

Access levels are now decided by persona pools (10.5).

- **Review rules (remembered approvals).** `scopes.review_policy` holds a JSON list of rules, applied at write path step 6, and the schema's own default for the column is the empty list `'[]'` (matching this description; v6's schema default of `'{}'` was a disagreement between the schema and this section, fixed in this revision):

```json
[{ "kind": "convention", "client": "claude-code@air", "action": "auto-accept", "created_by": "human", "created_at": "..." },
 { "kind": "decision", "confirmed_by_user": true, "action": "auto-accept" }]
```

Rules are created from `ctxd review` ("approve and remember") or `ctxd review --add-rule`. Their constraints:

- **Narrow by construction.** A rule must name a `kind`, and it must name a `client` or require `confirmed_by_user: true`. Global auto-accept is rejected.
- **Never for skills or preferences.** A rule may not name kind `skill` or `preference`. Skills are instructions other agents will follow, and preferences describe me; agent-written ones always wait for my approval.
- **Visible and revocable.** Rules are listed by `ctxd review --rules` and removed with `--remove-rule`.
- **Replicated, but only from a human.** Rules travel through scope metadata events, and only the `human` client can create or change them.

### 10.5 Access evaluation

Implements [PRD-pools-access-v3](../prd/components/PRD-pools-access-v3.md) sections 5 and 6. Every request carries a persona token, which identifies the client and its **assumed pools** for the session. `level(client, assumed pools, scope)` returns `none`, `read`, `propose` or `write`:

1. **Human client:** `write` for every scope (the `all` pool).
2. **Global `_me` (`kind = me`):** `read` for every client. For writes, `propose`, or `write` if a pool grants `_me` at `write`.
3. **Holding scope (`kind = hold`):** `write` for its owner client (with forced `proposed`), `none` for every other agent.
4. **Any other scope:** gather the candidates and take the highest:
   - `pool_grants` for every **assumed** pool (the token's pools, each of which must still list the client as a member, directly or by tag; a pool the client has left yields nothing);
   - unexpired `client_grants` rows for the client and scope.

   With no candidates, the result is `none`.
5. **Vendor policy:** if the scope's effective vendor policy is `local-only` and the client's vendor is not `local` or `human`, the result is `none`, whatever came before. Effective policies take the strictest of the scope's own setting and the defaults of every pool containing it.

**Operations by level:**

| Operation | Minimum level |
|---|---|
| `context_brief`, `context_search`, `context_get`, `context_handoff latest`, `context_claim list`, `context_flag` | `read` |
| `context_write`, `context_handoff write` | `propose` (status forced to `proposed`) or `write`; otherwise held (6, step 1) |
| `context_claim claim` and `release` | `propose` |
| Review actions, unflag, quarantine, revert, release, rollback, purge, pool and grant changes | Human client only |

**Session scope.** Because only assumed pools contribute grants, a client's other pools are unreachable in the session. The *working set* used by briefs (11) is the session scope, the global `_me` and the `_me.<pool>` profiles of the assumed pools.

**Denials.** Every `none` result on a tool call adds a `rejections` row with code `SCOPE_FORBIDDEN` or `HELD`, as metadata only.

**Caching.** Effective access per client is cached in memory and invalidated on any `acl` event or expiry of a temporary grant.

### 10.6 Sealed pools

Implements [PRD-pools-access-v3](../prd/components/PRD-pools-access-v3.md) section 7.1.

- **Separate file, same schema.** `ctxd pool seal <pool>` moves the pool's scopes, their entries, events, relations, flags, FTS and vector rows into a new database file under `sealed/`, named from the pool id. It uses the same schema, so the access layer and queries are unchanged apart from the database prefix.
- **Encryption at rest.** The file uses `better-sqlite3-multiple-ciphers` in SQLCipher compatibility mode. The key is 32 random bytes. Database construction is injected so tests use the same lifecycle with an isolated test provider.
- **Key storage.** The key is stored as a macOS Keychain item with a user-presence access control (Touch ID or password), created and read through a small signed helper, `ctxd-keyhelper`, that uses the LocalAuthentication framework.
  - The server asks the helper for the key the first time a session whose assumed pools include the sealed pool makes a call. I approve on the Mac.
  - The key is held in memory for the unlock window (`sealed.unlock_minutes`, default 60).
  - `ctxd pool lock <pool>` drops it at once.
- **Attach and detach.** The server attaches the file (`ATTACH DATABASE ... KEY ...`) only while the key is held, and routes queries for the pool's scopes to it. On lock or window expiry, it detaches.
- **Replication.** Events for sealed scopes are encrypted with the pool key (XChaCha20-Poly1305, with event id as associated data) before leaving the machine, and are served only to nodes in `pool_enrollments`. An enrolled node needs the key in its own Keychain, copied once with `ctxd pool enroll <pool> <node>` over the tailnet with my approval on both machines.
- **Backups and purge.** Backups copy the file as ciphertext before the normal `age` encryption. Purge (7.6.6) operates inside the sealed file when it is attached, and is queued until the next unlock otherwise.

#### 10.6.1 Key transfer to an enrolled node

10.6 already says an enrolled node's key is "copied once ... over the tailnet with my approval on both machines," but no authenticated mechanism existed: `SealedPoolStore.enroll` unconditionally threw "remote sealed key transfer is not implemented." This section designs that mechanism; it does not contradict 10.6, it fills in the "copied" step 10.6 already assumed. Built against the test key provider (W2 slices 2+); the real Keychain/Touch ID path is the owner's step (kickoff section 3 step 6).

**Every node has a long-lived, signed X25519 encryption keypair** (`node_encryption_keys`), separate from its Ed25519 event-signing identity (`node_keys`, M6). Generated lazily, once, the same way `FileEventKeyProvider` generates the Ed25519 identity: a PEM file beside `node.ed25519.pem`. The encryption public key is signed with the node's own Ed25519 private key (`sign(nodeId || encPublicKey)`), so a peer that already trusts this node's Ed25519 identity (via `peers.remote_public_key`, pinned at enrollment, M6) can verify the encryption key actually belongs to it, not to whoever answers on the wire. This is the "recipient's encryption key, bound to its already enrolled signing identity" the kickoff plan asks for, and it is symmetric: the source node signs and presents its own encryption key the same way, since the wrap step below is a Diffie-Hellman exchange, not one-sided.

**The transfer, over the existing sync channel** (two new POST endpoints on the existing peer-authenticated sync listener, `src/server/sync.ts`, never a new listener):

1. The recipient (the new node) calls `POST /v1/key-transfer/request` on the source (the node currently holding the key): `{pool, nodeId, encPublicKey, signature}`. The source verifies the signature against the recipient's already-pinned Ed25519 key and that the recipient is an un-revoked peer; it refuses otherwise. On success it creates a `sealed_key_transfers` row, status `pending`, with a short expiry (10 minutes).
2. **The owner's explicit approval, on the source node:** `ctxd pool approve-key-transfer <transferId>` is a human-only, local command; nothing above this line can move to `approved` without it. Approving computes the ECDH shared secret (`DH(source's X25519 private key, recipient's X25519 public key)`), derives a transfer key via HKDF, and wraps the pool's raw key with it (`encryptSealed`, the pool-event cipher, reused rather than reinvented, with the transfer id as associated data so a wrapped key can never be replayed against a different transfer).
3. **The confirmation code is derived from the same shared secret** (HKDF with a distinct context, truncated to 6 digits), not transmitted. Approving prints it on the source; the recipient's own completion step independently computes and prints the same digits from its side of the same ECDH exchange before it ever installs the key, so the owner compares the two screens, same intent as a Signal-style safety number, sized for a one-time two-device check rather than a standing identity comparison.
4. The recipient calls `POST /v1/key-transfer/fetch` with `transferId`. The source returns the wrapped key only when status is `approved` and `fetched_at` is still null, and marks `fetched_at` immediately in the same transaction: **the one-time-use rule that is this design's replay protection**: a captured or retried fetch request gets refused once consumed, a request replayed after its own expiry gets refused by the expiry check, and a request from a node that was since revoked gets refused by the revocation check, independent of either.
5. The recipient derives the same ECDH shared secret from its side, unwraps the key, confirms the code matches what the owner saw on the source, then calls its own `SealedKeyProvider.create(poolId)` and records `pool_enrollments` plus the `pool_enroll` acl event exactly as `ctxd pool seal` already does locally today.

**Refusal paths**, every one surfaced as a specific error rather than a generic failure: no approval yet (`fetch` before `approve`), wrong or already-used `transferId`, an expired pending request, a revoked or unknown requesting node (checked at request time, not just at approval), and a replayed fetch after the transfer is already consumed.

**Revoking a node:** at minimum, no new keys. A revoked node's peer record fails the un-revoked check at request time, so it can never start or complete a new transfer. **Existing sealed pools are not re-keyed** on revocation: a pool key a since-revoked node already received stays valid for whatever that node already holds, since rotating a pool's key and redistributing it to every other enrolled node is a materially heavier operation (decrypt and re-encrypt the sealed file, re-wrap for every remaining node) that this slice does not build. A future `ctxd pool rekey <pool>` is the place for that, not assumed here.

**Flag:** `sealed_pools.key_transfer`, off by default, gating both the new endpoints and the CLI commands; `ctxd pool enroll` keeps refusing outright when it is off, same as today.

### 10.7 Traversal rule

Implements [PRD-pools-access-v3](../prd/components/PRD-pools-access-v3.md) section 7.2. Every operation that moves from one entry to another re-evaluates `level` for the target's scope, under the session's persona:

- related entries in `context_get`;
- supersession chains and `superseded_by`;
- reference resolution;
- implements notices;
- relation lists in briefs and history.

When the result is `none`, or the target is in a sealed pool that is locked, the target is returned as `{ref, restricted: true}` with no kind, title, summary or status, and notices about it are not delivered.
