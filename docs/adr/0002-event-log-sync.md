# ADR 0002: Append-only event log with pull-based sync

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

We need multi-writer replication between two or three SQLite nodes with no central server and no quorum. The options surveyed are in [prior-art-v1](../research/prior-art-v1.md):

| Option | Why it does not fit |
|---|---|
| cr-sqlite | Dormant |
| LiteFS, Litestream | Single writer |
| rqlite, dqlite | Need quorum |
| Turso sync | Cloud-oriented |
| Dolt | Server for multi-writer, MySQL dialect |
| Syncing the database file | Unsafe |

## Decision

- **The event log is the source of truth.** Every change is an immutable event with a ULID, an origin node and per-node sequence number, an HLC timestamp, the parent revision(s) and the authoring client.
- **State is derived.** Entry state, FTS and vectors are materialized locally and can be rebuilt.
- **Nodes pull events from peers** using a per-origin version vector. The `through` watermark lets filtered events be skipped without gaps.
- **Concurrent edits follow per-kind conflict policies** (spec section 7.4). Immutable kinds never conflict, `status` and `brief` use last-writer-wins with the loser retained, and other kinds are surfaced for review rather than guessed.

## Consequences

- Replication is a set union of immutable events, which is simple to reason about and test.
- Correctness depends on deterministic apply, verified by property tests with random partitions and delivery orders.
- The log grows forever. Compaction of old superseded revisions is a later concern (not before M6).
- The SQLite session extension remains a fallback if row-level replication of derived tables is ever needed.
