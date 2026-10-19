# ctxd Component PRD: Replication and Offline Work (v5)

| | |
|---|---|
| **Status** | Draft v5 |
| **Date** | 2026-10-19 |
| **Supersedes** | [v4](PRD-replication-v4.md) |
| **Parent** | [ctxd PRD v7](../PRD-v7.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v3.md), [Persona pools and access](PRD-pools-access-v2.md), [Hooks and agent lifecycle](PRD-hooks-v5.md), [Claims and write intent](PRD-claims-v3.md), [Trust and safety](PRD-trust-safety-v4.md), [Context hygiene](PRD-context-hygiene-v1.md), [Briefs and search](PRD-briefs-search-v4.md) |
| **Spec** | [Spec v8](../../spec/SPEC-v8.md) sections 4, 5, 7 and 12 |
| **ADRs** | [0001 Local-first replicated store](../../adr/0001-local-first-replicated-store.md), [0002 Event log sync](../../adr/0002-event-log-sync.md), [0004 Embeddings replicate](../../adr/0004-embeddings-replicate.md) |
| **Parent requirements elaborated** | FR-13, FR-14, FR-15, FR-17 (cross-machine); FR-20 (embeddings replicate); NFR-2, NFR-5, NFR-6, NFR-7 |
| **Adapted from** | [OpenWork](https://github.com/different-ai/openwork) remote-sessions journal (input fingerprints for retried requests); [DataHub](https://github.com/datahub-project/datahub) per-aspect versioning |

## Changes in v5

Earlier changes are listed in [v4](PRD-replication-v4.md).

| Change | Section |
|---|---|
| Embedding vectors now replicate as ordinary event data, computed once by a `semantic_search.compute` machine; FTS indexes still never replicate. Reverses v4's blanket "search indexes and embeddings never replicate" for embeddings only. See [ADR 0004](../../adr/0004-embeddings-replicate.md) | 3 |
| RQ-3 resolved: the hub is a temporary Intel MacBook Air, replaced later by a Mac Studio; it will not run the embedding model itself either before or after that move | 2, 9 |
| New requirements RP-16 and RP-17 for embedding replication and its fallback | 7 |

## 1. Purpose

I work on more than one Mac, sometimes with poor or filtered connections back home. Every machine must work fully offline and converge with the others when they can reach each other, without a server on the internet and without losing anyone's writes.

## 2. Machines and roles

| Machine | Role | Notes |
|---|---|---|
| MacBook Air (Intel) | `home`, hub | Always on and always on the tailnet; holds every scope it is allowed; temporary, approaching macOS end of life; never runs the embedding model (RQ-3, resolved) |
| Daily driver | `roaming` | Travels; never receives `home`-only scopes; the machine that computes embeddings today (`semantic_search.compute` on), since it already runs active sessions |
| Mac Studio (planned) | `home`, hub | Replaces the Air; adds a local model, and can take over embedding compute once it arrives |

Each machine runs its own ctxd with a full copy of the scopes it may hold. Agents only ever talk to the copy on their own machine.

## 3. What replicates

| Scope replication | Home machines | Roaming machines |
|---|---|---|
| `all` | Yes | Yes |
| `home` | Yes | No |
| `local` | No (stays on the machine that wrote it) | No |

**Search indexes (FTS5) never replicate; each machine rebuilds its own.** This is unchanged from v4 and from [ADR 0002](../../adr/0002-event-log-sync.md): FTS is a cheap, purely local, derived view, and carries no meaning across machines.

**Embeddings replicate** ([ADR 0004](../../adr/0004-embeddings-replicate.md), new in v5). A machine with the `semantic_search.compute` flag on computes a vector for each entry revision it writes, using a small, fixed, CPU-friendly local model, and tags it with the model's id and dimension. The vector is carried through sync exactly like any other part of the entry, under the same scope replication and vendor policy. Any machine can serve hybrid search over whatever vectors have already arrived, whether or not it computed them itself: this is what lets the temporary Intel Air hub serve search without ever running the model, and lets the eventual Mac Studio hub take over computing once it arrives, with no change needed on other machines. A revision with no vector yet (nothing with `semantic_search.compute` on has processed it) is not an error; search for it falls back to full-text only, same as `semantic_search` off does everywhere.

**Access metadata.** Pools, grants, memberships, tags and temporary grants replicate to every machine, so an agent has the same access everywhere ([Persona pools and access](PRD-pools-access-v2.md)). Only changes made by the human client are accepted.

**Holding scopes** (`_hold.<client>`) replicate only to home machines, never to the roaming laptop.

**Sealed pools** ([Persona pools and access](PRD-pools-access-v2.md) section 7.1) replicate only to machines I enroll for them. Their changes are encrypted with the pool key before they leave the machine, so a machine that relays them without the key, or a backup, holds only ciphertext. Embeddings for a sealed scope's entries are exactly as restricted: encrypted the same way, never computed or stored outside the enrolled machines.

**Persona tokens.** Token hashes, rotations and revocations replicate, so a revoked token stops working everywhere. Token secrets never leave the Keychain of the machine where they were issued; each machine issues its own.

## 4. How it behaves for me

- **Writes are instant and local.** Nothing waits on the network.
- **Sync is automatic.** It runs every couple of minutes, on reconnect, and shortly after local writes, over Tailscale only.
- **Briefs show freshness.** Every brief says when the machine last synced, so an agent (and I) can tell when information might be stale.
- **Nothing is lost.** Every write made while disconnected reaches the other machines when they reconnect.
- **Retries are safe.** A write retried after a dropped connection is applied once. A retry that reuses a request id with *different* content is refused instead of being silently treated as a duplicate.
- **Search degrades gracefully, never blocks.** A machine that has not yet received an entry's vector, or never computes vectors itself, still searches it by full text; hybrid ranking improves as vectors arrive, it is never a precondition for search to work at all.

## 5. Conflicts

Concurrent edits made on two machines while disconnected are handled **per part**. Edits to different parts of one entry merge cleanly. When both machines change the **same** part:

| Part | Outcome |
|---|---|
| Content of decisions, handoffs, pointers | Cannot happen (immutable; changes are new entries that supersede old ones) |
| Content of status and brief entries | The later edit wins; the other is kept in history and shown as auto-resolved in review |
| Content of conventions, facts, lessons, notes, tasks | Marked conflicted; both versions kept; I merge in `ctxd review` |
| Status | A change I made wins over an agent's; otherwise the later change wins |
| Relations | Merged: additions from both sides are kept; a removal wins only over the specific link it removed |
| Delete vs. edit | The edit wins; the delete is kept in history |
| Claims | Defined in [Claims](PRD-claims-v3.md) sections 5 and 9 (earliest claim wins; overlaps surfaced) |
| Embedding vectors | Cannot conflict: a vector is keyed by its model id, so two machines computing with the same model produce the same payload for the same text, and a different model id is kept alongside rather than overwriting |

### 5.1 Cleanup operations across machines

([Context hygiene](PRD-context-hygiene-v1.md))

- **Flags, quarantine batches, reverts and releases** are ordinary changes. They replicate and converge like any other.
- **A purge** replicates as a special change. Every machine that applies it erases the entry's content and the content of its recorded changes, including any embedding vector computed for it. A machine that receives older changes for a purged entry, for example from a peer that was offline, strips their content on arrival and never shows it.
- **A revert conflicting with a later edit.** If a revert meets a later edit made on another machine, the entry is marked conflicted for my review rather than either side silently winning.

## 6. Moving the hub

When the Mac Studio arrives, moving the hub is a data copy, a configuration change and a Tailscale name change. Clients on other machines need no changes. The Studio may also turn `semantic_search.compute` on for itself at that point, taking over embedding work the daily driver was doing; nothing elsewhere needs to change for that either, since vectors already replicate regardless of which machine produced them.

## 7. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| RP-1 | Full local replica per machine; all reads and writes work offline | FR-13, NFR-2 | P1 |
| RP-2 | Pull-based sync over Tailscale only, triggered on schedule, reconnect and local writes | FR-13, NFR-1 | P1 |
| RP-3 | Scope replication policies enforced when serving events | FR-15 | P1 |
| RP-4 | Per-part conflict handling as in section 5; conflicts listed in review | FR-14 | P1 |
| RP-5 | Every machine with the same events reaches identical state regardless of arrival order | NFR-5 | P1 |
| RP-6 | Idempotent writes keyed by request id, with an input fingerprint; same id with different input is rejected | FR-4 | P0 |
| RP-7 | Briefs report last successful sync time per peer | FR-5 | P1 |
| RP-8 | Partitioned writes are never lost; all eligible events replicate within 5 minutes of reconnection | NFR-5 | P1 |
| RP-9 | Hub migration requires only data copy, configuration and a name change | NFR-7 | P1 |
| RP-11 | Pool and access metadata replicate; only human-client changes accepted | FR-33 | P0 |
| RP-12 | Purge enforced on every machine, including late arrivals of old changes | FR-40 | P0 |
| RP-13 | Holding scopes replicate to home machines only | FR-33 | P1 |
| RP-14 | Sealed pools replicate only to enrolled machines, encrypted end to end | FR-42 | P1 |
| RP-15 | Token hashes and revocations replicate; secrets never do | FR-35 | P0 |
| RP-10 | A lost machine's sync access can be revoked from the hub | [Trust and safety](PRD-trust-safety-v4.md) | P1 |
| RP-16 | Embedding vectors replicate as event data, tagged with model id and dimension, under the same scope and vendor policy as the entry they describe | FR-20 | P2 |
| RP-17 | A machine with `semantic_search.compute` off serves hybrid search over vectors it never computed; an entry with no vector yet falls back to full-text search, never an error | FR-20 | P2 |

## 8. Acceptance criteria

- Edit the same project on two machines while disconnected, reconnect, and both show identical content, with conflicts listed for review.
- Approving an entry on one machine while another machine adds a relation to it merges without a conflict.
- A `home` scope never appears on the roaming laptop, even after many sync cycles.
- Killing sync mid-transfer and restarting it neither duplicates nor drops events.
- The partition property test suite passes with random operations, partitions and delivery orders.
- A machine with `semantic_search.compute` off and no embedding model installed serves a hybrid search query correctly once it has synced vectors a `semantic_search.compute` machine produced.

## 9. Open questions

| # | Question |
|---|---|
| RQ-1 | Tailscale identity header use for tagged nodes (Spec open issue 4) |
| RQ-2 | Event log compaction policy for old superseded revisions (after M6) |
| RQ-3 | **Resolved in v5.** The hub is a temporary Intel MacBook Air; replaced later by a Mac Studio. Neither runs the embedding model as part of being the hub; the daily driver computes embeddings today. |
