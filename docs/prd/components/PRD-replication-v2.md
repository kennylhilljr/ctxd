# ctxd Component PRD: Replication and Offline Work (v2)

| | |
|---|---|
| **Status** | Draft v2 |
| **Date** | 2026-10-17 |
| **Supersedes** | [v1](PRD-replication-v1.md) |
| **Parent** | [ctxd PRD v3](../PRD-v3.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v1.md), [Hooks and agent lifecycle](PRD-hooks-v2.md), [Claims and write intent](PRD-claims-v2.md), [Trust and safety](PRD-trust-safety-v2.md), [Briefs and search](PRD-briefs-search-v2.md) |
| **Spec** | [Spec v3](../../spec/SPEC-v3.md) sections 4, 5, 7 and 12 |
| **ADRs** | [0001 Local-first replicated store](../../adr/0001-local-first-replicated-store.md), [0002 Event log sync](../../adr/0002-event-log-sync.md) |
| **Parent requirements elaborated** | FR-13, FR-14, FR-15, FR-17 (cross-machine); NFR-2, NFR-5, NFR-6, NFR-7 |
| **Adapted from** | [OpenWork](https://github.com/different-ai/openwork) remote-sessions journal (input fingerprints for retried requests); [DataHub](https://github.com/datahub-project/datahub) per-aspect versioning |

## Changes in v2

Conflicts are now decided **per part of an entry** (content, status, relations, claim), following the [Knowledge model](PRD-knowledge-model-v1.md) section 4. Edits to different parts of the same entry on different machines no longer conflict. Section 5 is updated accordingly.

OpenViking's multi-write storage was also reviewed: it keeps one primary with asynchronous backups, which does not allow offline writes on a second machine, so ctxd's design is unchanged.

## 1. Purpose

I work on more than one Mac, sometimes with poor or filtered connections back home. Every machine must work fully offline and converge with the others when they can reach each other, without a server on the internet and without losing anyone's writes.

## 2. Machines and roles

| Machine | Role | Notes |
|---|---|---|
| MacBook Air | `home`, hub | Always on and always on the tailnet; holds every scope it is allowed |
| Main Mac | `roaming` | Travels; never receives `home`-only scopes |
| Mac Studio (planned) | `home`, hub | Replaces the Air; adds a local model |

Each machine runs its own ctxd with a full copy of the scopes it may hold. Agents only ever talk to the copy on their own machine.

## 3. What replicates

| Scope replication | Home machines | Roaming machines |
|---|---|---|
| `all` | Yes | Yes |
| `home` | Yes | No |
| `local` | No (stays on the machine that wrote it) | No |

Search indexes and embeddings never replicate; each machine rebuilds its own.

## 4. How it behaves for me

- **Writes are instant and local.** Nothing waits on the network.
- **Sync is automatic.** It runs every couple of minutes, on reconnect, and shortly after local writes, over Tailscale only.
- **Briefs show freshness.** Every brief says when the machine last synced, so an agent (and I) can tell when information might be stale.
- **Nothing is lost.** Every write made while disconnected reaches the other machines when they reconnect.
- **Retries are safe.** A write retried after a dropped connection is applied once. A retry that reuses a request id with *different* content is refused instead of being silently treated as a duplicate.

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
| Claims | Defined in [Claims](PRD-claims-v2.md) sections 5 and 9 (earliest claim wins; overlaps surfaced) |

## 6. Moving the hub

When the Mac Studio arrives, moving the hub is a data copy, a configuration change and a Tailscale name change. Clients on other machines need no changes.

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
| RP-10 | A lost machine's sync access can be revoked from the hub | [Trust and safety](PRD-trust-safety-v2.md) | P1 |

## 8. Acceptance criteria

- Edit the same project on two machines while disconnected, reconnect, and both show identical content, with conflicts listed for review.
- Approving an entry on one machine while another machine adds a relation to it merges without a conflict.
- A `home` scope never appears on the roaming laptop, even after many sync cycles.
- Killing sync mid-transfer and restarting it neither duplicates nor drops events.
- The partition property test suite passes with random operations, partitions and delivery orders.

## 9. Open questions

| # | Question |
|---|---|
| RQ-1 | Tailscale identity header use for tagged nodes (Spec open issue 4) |
| RQ-2 | Event log compaction policy for old superseded revisions (after M6) |
| RQ-3 | MacBook Air model and macOS support status (parent Q1) |
