# ctxd

A local-first shared context store for AI agents. Claude Code, Codex, Claude Desktop and other MCP clients share one memory of your projects (decisions, status, conventions, handoffs), replicated across your own Macs over Tailscale. Nothing is exposed to the internet.

> **Status:** M0 (design and scaffold). The PRD, spec and ADRs are complete; implementation starts at M1.

## How it works

- **A server per machine.** Each Mac runs `ctxd server` with a full replica of the scopes it may hold. Clients talk only to `127.0.0.1`.
- **Hooks do the work.** Hooks load a compact brief when a session starts and capture a handoff when work ends ([Hooks PRD](docs/prd/components/PRD-hooks-v4.md)).
- **Private sync.** Replicas sync over your tailnet using an append-only event log, and work fully offline ([ADR 0002](docs/adr/0002-event-log-sync.md)).
- **Reviewed content.** Agent-written decisions and conventions are *proposed* until you approve them with `ctxd review`.
- **Persona pools.** Agents are assigned to personas that grant specific projects; each session assumes one persona, agents share context inside a pool, and they never write into one without your permission ([Pools PRD](docs/prd/components/PRD-pools-access-v2.md)).
- **Easy cleanup.** Flag, quarantine and revert, roll back, or purge bad context ([Context hygiene PRD](docs/prd/components/PRD-context-hygiene-v1.md)).
- **Claims with write intent.** Agents declare which paths they will touch, so overlaps between agents are caught early ([Claims PRD](docs/prd/components/PRD-claims-v3.md)).

## Documents

The PRD is a parent document plus component PRDs that reference each other. Each document is versioned by file name (`-v1`, `-v2`, and so on); earlier versions stay for tracking.

| Document | Purpose |
|---|---|
| [PRD v5](docs/prd/PRD-v5.md) (parent) | Vision, goals, scope, cross-cutting requirements, milestones, risks, and the index of component PRDs |
| [Knowledge model](docs/prd/components/PRD-knowledge-model-v2.md) | What is stored: kinds, statuses, versioned parts, references, relationships, history |
| [Persona pools and access](docs/prd/components/PRD-pools-access-v2.md) | Who sees and writes what: one persona per session, persona tokens, sealed pools, holding scopes, access requests |
| [Hooks and agent lifecycle](docs/prd/components/PRD-hooks-v4.md) | **When agents read and write**: hooks, the Stop-hook nudge, per-client behavior, crash sweep, bypass |
| [Claims and write intent](docs/prd/components/PRD-claims-v3.md) | Task claims, write intent, overlap, drift, stale-claim takeover |
| [Trust and safety](docs/prd/components/PRD-trust-safety-v4.md) | Redaction, capture filters, path guard, provenance, review queue, tokens |
| [Context hygiene](docs/prd/components/PRD-context-hygiene-v1.md) | Cleaning bad context: flag, quarantine and revert, rollback, purge, tidy |
| [Replication and offline work](docs/prd/components/PRD-replication-v4.md) | Per-machine replicas, sync over Tailscale, per-part conflicts, purge propagation |
| [Briefs and search](docs/prd/components/PRD-briefs-search-v3.md) | What agents receive when they read: detail tiers, lessons, caps, persona narrowing |
| [Spec v5](docs/spec/SPEC-v5.md) | Architecture, data model, MCP tools, hooks, sync, access, cleanup, security, operations; traceability |
| [Prior art v3](docs/research/prior-art-v3.md) | Survey of related projects and what was adopted |
| [ADRs](docs/adr/) | Key decisions |

## Privacy of names

Repositories never contain ctxd configuration, and nothing in this repository uses real project, scope or pool names. Bindings between repositories and scopes live only in ctxd's local data. All examples here are invented.

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
src/model    entry references (relations and history in M1)
src/hooks    nudge state machine, scope resolution from git origin, bypass
src/store    schema and write path
src/sync     pull protocol and event apply
src/brief    brief assembly
src/search   ranking
deploy/      launchd and client configuration examples
```

## Versioning of documents

Each round of edits to the PRD, spec or research creates a new numbered file (`PRD-v2.md`, and so on). Earlier versions stay in place for tracking.
