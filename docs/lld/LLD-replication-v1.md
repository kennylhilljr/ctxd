# ctxd LLD: Replication (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 7 |
| **Implements** | [Replication and offline work](../prd/components/PRD-replication-v6.md) (RP-1 to RP-17); signed events from [Trust and safety](../prd/components/PRD-trust-safety-v5.md) |
| **Owner** | A (agent-generated) by persona `component-designer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/sync/`, `src/store/materialize.ts` |
| **Moved from** | Spec v9 sections 7.1 to 7.4 and 7.7 |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 7. Replication

Claim semantics (7.5) are in [LLD: Claims](LLD-claims-v1.md); cleanup operations (7.6) are in [LLD: Context hygiene](LLD-context-hygiene-v1.md).

### 7.1 Protocol

- **Endpoint:** `POST /v1/pull`, served on the sync listener and reachable only through `tailscale serve`.
- **Request:** `{ "node": "<requesting node_id>", "vector": { "<origin_node>": <through_seq>, ... }, "limit": 500 }`
- **Response:** `{ "events": [...], "through": { "<origin_node>": <seq>, ... }, "more": true|false }`
- **What the server returns:** events where `origin_seq > vector[origin]`, ordered by `(origin_node, origin_seq)`, filtered by the replication policy for the requesting node (7.2).
- **How `through` works:** it reports the highest seq the server *considered* per origin, including filtered events. The puller can therefore advance past events it is not allowed to receive without seeing a gap.
- **Relaying:** a node serves events from every origin it holds, not just its own, so replication works through the hub.
- **Puller loop:**
  1. Apply each event idempotently; `event_id` is unique, so duplicates are ignored.
  2. Store `through` in `sync_state`.
  3. Repeat while `more` is true.
- **Triggering:**
  - **Scheduled:** every `interval_seconds`.
  - **On reconnect:** when a peer becomes reachable again.
  - **On demand:** when a peer sends `POST /v1/notify` after local writes (debounced to 5 seconds).
- **Authentication:** each node holds a peer token for every peer, sent as a bearer token and stored as a hash. Optionally (verify), the server also requires the Tailscale identity header that `tailscale serve` adds, and checks it against an allowlist.

### 7.2 Replication policy filter

| Scope replication | Sent to `home` nodes | Sent to `roaming` nodes |
|---|---|---|
| `all` | Yes | Yes |
| `home` | Yes | No |
| `local` | No | No |

Scope and client definitions replicate as metadata events in a reserved `_system` scope with replication `all`. Token hashes for client tokens do **not** replicate; each node issues its own client tokens.

### 7.3 Applying an event

Apply is per part. Let `E` be an incoming event for part `P` of entry `X`, with current head rev `H` for that part:

| Case | Condition | Action |
|---|---|---|
| Fast-forward | `E.parent_revs == [H]`, or `X` does not exist and `E.op == create` | Apply; `E.rev` becomes the head |
| Already known | `E.rev` is an ancestor of `H` | Record the event; no state change |
| Missing parent | `E.parent_revs` references an unknown rev | Hold in a pending queue until the parent arrives (bounded; alert after 24 hours) |
| Concurrent | Otherwise | Apply the conflict policy for part `P` and `X.kind` (7.4) |

Events for different parts of the same entry never interact: a status change and a content edit made concurrently both fast-forward their own part.

### 7.4 Conflict policies

Implements [PRD-replication-v6](../prd/components/PRD-replication-v6.md) section 5. Policies apply only when two events change the **same part** concurrently.

| Part and kind | Policy on concurrent updates |
|---|---|
| Content of `decision`, `handoff`, `pointer` | Immutable after creation, so content cannot conflict. |
| Status (all kinds) | A human-client event wins; otherwise the later HLC wins. The loser is kept as a sibling. |
| Relations (all kinds) | Add-wins set keyed by `link_id`: every `relate` is kept; an `unrelate` removes only the `link_id` it names. Never conflicts. |
| Content of `status`, `brief` | Last writer wins by HLC. The losing rev is stored in `entry_siblings` with reason `lww`, and the entry is listed in review as "auto-resolved." |
| Content of `convention`, `fact`, `lesson`, `note`, `task` | The entry moves to `conflicted`. Both revs are kept; the head is the higher HLC so reads still work, and reads mark it conflicted. A `resolve` event, whose `parent_revs` lists both, clears it. |
| Delete vs. update | The update wins and the entry is restored, with a sibling marking the losing delete. Deletes are tombstones (`status = deleted`); rows are never physically removed during sync. |
| Concurrent claims on one task | The earliest `claim_hlc` wins. The loser's lease moves to state `lost` with `lost_by` set, and the losing client sees a notice in its next brief. Claims made while a node has had no successful sync for 10 minutes are flagged `tentative`. |
| Concurrent claims on different tasks with overlapping write intent | Both claims stand (they were valid locally). Applying the second one runs the overlap test (7.5.2) and records a `claim_overlaps` row with origin `sync`; both holders see a notice. Under `strict`, the later claim by HLC is additionally flagged for review; nothing is revoked automatically. |

**Convergence property:** for any set of events, every node that has applied the same set reaches identical materialized state, whatever the arrival order. This is enforced by the property tests in section 14. Overlap rows are derived state and are included in the convergence check. Purge follows the same property (7.6.6): its event payload carries enough of the entry's structure that a rebuild reconstructs the purged row identically, whether the entry's create event had already been materialized or not.

### 7.7 Signed events

When `signed_events` is on, every new local event is signed with the node's Ed25519 key. The
private key is stored outside the event database with mode `0600`; the public key is included with
the event and pinned to its origin node on first verification. A later event that presents another
key for the same origin is refused.

The signed value is a SHA-256 hash of canonical JSON containing the event payload and prior value.
Replication verifies the hash and signature before storing or materializing an event. Rebuild
verifies every stored signature. Unsigned legacy events remain valid.

Purge retains `payload_hash`, `signature`, and `public_key` while erasing payload and prior
content. After erasure, verification checks the Ed25519 signature over the retained hash. It cannot
and does not reconstruct erased content. Verification continues while `signed_events` is off. The
off path stops signing new events and never removes existing signature data.
