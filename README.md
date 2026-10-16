# ctxd

A local-first shared context store for AI agents. Claude Code, Codex, Claude Desktop and other MCP clients share one memory of your projects (decisions, status, conventions, handoffs), replicated across your own Macs over Tailscale. Nothing is exposed to the internet.

> **Status:** M0 (design and scaffold). The PRD, spec and ADRs are complete; implementation starts at M1.

## How it works

- **A server per machine.** Each Mac runs `ctxd server` with a full replica of the scopes it may hold. Clients talk only to `127.0.0.1`.
- **Hooks do the work.** Hooks load a compact brief when a session starts and capture a handoff when work ends ([PRD section 6](docs/prd/PRD-v1.md#6-when-agents-read-and-write-the-heart-of-the-product)).
- **Private sync.** Replicas sync over your tailnet using an append-only event log, and work fully offline ([ADR 0002](docs/adr/0002-event-log-sync.md)).
- **Reviewed content.** Agent-written decisions and conventions are *proposed* until you approve them with `ctxd review`.

## Documents

| Document | Purpose |
|---|---|
| [PRD v1](docs/prd/PRD-v1.md) | What and why, including exactly when agents read and write |
| [Spec v1](docs/spec/SPEC-v1.md) | Architecture, data model, MCP tools, hooks, sync, security, operations |
| [Prior art v1](docs/research/prior-art-v1.md) | Survey of related open-source projects and sync engines |
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
src/security redaction and network/vendor policies
src/hooks    nudge state machine and scope resolution
src/store    schema and write path
src/sync     pull protocol and event apply
src/brief    brief assembly
src/search   ranking
deploy/      launchd and client configuration examples
```

## Versioning of documents

Each round of edits to the PRD, spec or research creates a new numbered file (`PRD-v2.md`, and so on). Earlier versions stay in place for tracking.
