# ADR 0001: Local-first store with a full replica per machine

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Agents on several machines need shared context. Network access back to the home network may be limited or filtered while traveling, and an internet-hosted service is unacceptable (see ADR 0003).

## Decision

Every machine runs its own `ctxd server` with a full replica of the scopes it is allowed to hold. All clients talk only to the server on their own machine over `127.0.0.1`. Replicas converge through the sync protocol whenever they can reach each other.

The always-on MacBook Air acts as the hub; the traveling laptop is a `roaming` node. The Mac Studio replaces the Air as hub when it arrives.

## Consequences

- Reads and writes work fully offline, with local latency.
- Multi-writer replication and conflict handling become a core responsibility (ADR 0002).
- Scope replication policies (`all`, `home`, `local`) are required, so sensitive scopes can stay off the laptop.
- There is no single always-consistent view. Briefs show sync age so agents and I know how fresh they are.
