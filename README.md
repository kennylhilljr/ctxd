# ctxd

A local-first shared context store for AI agents. Claude Code, Codex, Claude Desktop and other MCP clients share one memory of your projects (decisions, status, conventions, handoffs), replicated across your own Macs over Tailscale. Nothing is exposed to the internet.

> **Status:** M0 (design and scaffold). The PRD, spec and ADRs are complete; implementation starts at M1.

## How it works

- **A server per machine.** Each Mac runs `ctxd server` with a full replica of the scopes it may hold. Clients talk only to `127.0.0.1`.
- **Hooks do the work.** Hooks load a compact brief when a session starts and capture a handoff when work ends ([Hooks PRD](docs/prd/components/PRD-hooks-v1.md)).
- **Private sync.** Replicas sync over your tailnet using an append-only event log, and work fully offline ([ADR 0002](docs/adr/0002-event-log-sync.md)).
- **Reviewed content.** Agent-written decisions and conventions are *proposed* until you approve them with `ctxd review`.
- **Claims with write intent.** Agents declare which paths they will touch, so overlaps between agents are caught early ([Claims PRD](docs/prd/components/PRD-claims-v1.md)).

## Documents

The PRD is a parent document plus component PRDs that reference each other. Each document is versioned by file name (`-v1`, `-v2`, and so on); earlier versions stay for tracking.

| Document | Purpose |
|---|---|
| [PRD v2](docs/prd/PRD-v2.md) (parent) | Vision, goals, scope, cross-cutting requirements, milestones, risks, and the index of component PRDs |
| [Hooks and agent lifecycle](docs/prd/components/PRD-hooks-v1.md) | **When agents read and write**: hooks, the Stop-hook nudge, per-client behavior, adapters |
| [Claims and write intent](docs/prd/components/PRD-claims-v1.md) | Task claims, write intent, overlap, drift, stale-claim takeover |
| [Trust and safety](docs/prd/components/PRD-trust-safety-v1.md) | Redaction, provenance, review queue, tokens and access, network exposure |
| [Replication and offline work](docs/prd/components/PRD-replication-v1.md) | Per-machine replicas, sync over Tailscale, conflicts |
| [Briefs and search](docs/prd/components/PRD-briefs-search-v1.md) | What agents receive when they read |
| [Spec v2](docs/spec/SPEC-v2.md) | Architecture, data model, MCP tools, hooks, sync, security, operations; traceability to the component PRDs |
| [Prior art v2](docs/research/prior-art-v2.md) | Survey of related projects, including coordinate-agents and OpenWork, and what was adopted |
| [ADRs](docs/adr/) | Key decisions |

## Development

```bash
nvm use        # Node 24
npm install
npm run typecheck
npm test
```

## Layout

```
src/cli      command entry points
src/core     HLC clock, ids, errors, token estimates, kinds
src/tools    MCP tool contracts and server instructions
src/security sanitization pipeline, detectors, network and vendor policies
src/claims   write-intent normalization, overlap test, drift
src/hooks    nudge state machine and scope resolution
src/store    schema and write path
src/sync     pull protocol and event apply
src/brief    brief assembly
src/search   ranking
deploy/      launchd and client configuration examples
```

## Versioning of documents

Each round of edits to the PRD, spec or research creates a new numbered file (`PRD-v2.md`, and so on). Earlier versions stay in place for tracking.
