# ctxd Vision (v1)

| | |
|---|---|
| **Status** | Draft v1, **awaiting the owner's review**. Vision is a human-owned (H) layer; this draft was assembled by persona `analyst` only from statements the owner already made in [PRD v7](../prd/PRD-v7.md) sections 1 to 3, 9 and 10. Nothing here is new. Edit freely, then mark it approved |
| **Date** | 2026-10-20 |
| **Layer** | L0 vision and strategy |
| **Owner** | H |
| **Children** | [PRD v8](../prd/PRD-v8.md) |

## 1. Why

> **H** · the owner writes it (`analyst` may interview to capture it)

Every new AI session starts from zero, context is trapped inside each tool, long sessions can be lost with everything they learned, and parallel agents repeat or collide with each other's work. A cloud-hosted memory would fix some of this, but exposing it on the internet is not acceptable.

## 2. Who it serves

> **H** · the owner writes it

The owner, working across personal projects in many AI tools (Claude Code, Codex, Claude Desktop and others), and the agents themselves, each with its own identity.

## 3. What it is, in one paragraph

> **H** · the owner writes it

ctxd is a small, local-first context store that every agent the owner uses can read from and write to over MCP: one shared memory of decisions, status, conventions, handoffs, preferences, skills and a journal. It runs only on the owner's own Macs, with a full replica on each, synced privately over Tailscale. What matters most is not the database but **when agents read and write**: hooks load a brief when a session starts and capture a handoff when it ends, so continuity never depends on an agent remembering.

## 4. Principles

> **H** · the owner writes it. These seed the rules in [AGENTS.md](../../AGENTS.md)

1. **Continuity across tools.** Any supported agent starts a session already knowing the brief, status, recent decisions and last handoff.
2. **Automatic, not aspirational.** Reads and writes at session boundaries happen through hooks.
3. **Small and relevant reads.** Budgeted briefs and targeted search; shared context must save tokens.
4. **Local-first and private.** Every machine works offline; nothing is exposed to the internet.
5. **Trustworthy content.** Every entry is attributed; important agent-written content waits for the owner's review.
6. **Safe concurrency.** No agent or machine silently overwrites another.
7. **Durable.** Losing a session, a chat or a machine loses no accumulated knowledge.

## 5. Outcomes

> **H** · the owner writes it

| Outcome | Target |
|---|---|
| Sessions start with a brief and need no manual recap | At least 80% over 4 weeks of use |
| Sessions that changed code end with a handoff or a mechanical record | At least 90% |
| Switching tools mid-task needs no pasted summary | Always |
| Proposed entries rejected in review | Fewer than 20% |
| Data loss across sync; network exposure findings | Zero |

## 6. Horizon

> **C** · `planner` drafts options, the owner decides

M0 to M6 are implemented (single-node core, hooks and claims, replication, home-hub deployment, semantic search and digests, signed events, mirror and sealed pools); the owner's steps for moving the hub remain, per the [M6 handoff](../build/M6-handoff-v1.md). M7, a mobile inbox, is optional and in progress. Milestone detail lives in [PRD v8](../prd/PRD-v8.md) section 10.

## 7. Non-goals

> **H** · the owner writes it

Public or internet-reachable hosting of any kind; cloud chat clients as live clients; storing full transcripts; copying code or documents; any work data or employer device; multi-user or team features.

## 8. Open questions

> **A** · written by `analyst`

- Is this the vision the owner wants to hold the PRD to, or should it reach further than ctxd v1 (for example the Mac Studio's local model as a first-class client)?
- Should outcome targets be re-baselined now that M0 to M6 are built?
