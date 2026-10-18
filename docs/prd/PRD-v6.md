# ctxd: Shared Context for AI Agents (PRD v6)

| | |
|---|---|
| **Status** | Draft v6 |
| **Owner** | Kenny Hill |
| **Date** | 2026-10-18 |
| **Supersedes** | [PRD v5](PRD-v5.md) |
| **Component PRDs** | [Knowledge model](components/PRD-knowledge-model-v3.md), [Persona pools and access](components/PRD-pools-access-v2.md), [Hooks](components/PRD-hooks-v5.md), [Claims](components/PRD-claims-v3.md), [Trust and safety](components/PRD-trust-safety-v4.md), [Context hygiene](components/PRD-context-hygiene-v1.md), [Replication](components/PRD-replication-v4.md), [Briefs and search](components/PRD-briefs-search-v4.md), [Filesystem view](components/PRD-filesystem-view-v1.md), [Skills](components/PRD-skills-v1.md), [Memory and journal](components/PRD-memory-journal-v1.md) |
| **Companion docs** | [Technical spec v6](../spec/SPEC-v6.md), [Prior art v4](../research/prior-art-v4.md), [ADRs](../adr/) |

## Changes in v6

Earlier changes are listed in [PRD v5](PRD-v5.md), [v4](PRD-v4.md), [v3](PRD-v3.md) and [v2](PRD-v2.md).

| Change | Detailed in |
|---|---|
| **Filesystem view.** Every entry has a readable `ctxd://` path; folders carry one-line and overview summaries; I can browse with `ctxd ls`, `tree` and `read`, and optionally edit a Markdown mirror. The typed store stays the source of truth | [Filesystem view v1](components/PRD-filesystem-view-v1.md); FR-43 to FR-45 |
| **Skills.** Reusable procedures stored once, in `SKILL.md` form, shared with every agent the persona allows, listed in briefs, approved by me, and optionally synced into Claude Code and Codex | [Skills v1](components/PRD-skills-v1.md); FR-46 to FR-49 |
| **Memory.** A `preference` kind and a "remember that..." flow organize what agents know about me in `_me` and pool profiles | [Memory and journal v1](components/PRD-memory-journal-v1.md) 2; FR-50 |
| **Journal.** A time-ordered log per scope with significance, filled automatically by hooks, with day views, weekly digests and time-filtered search | [Memory and journal v1](components/PRD-memory-journal-v1.md) 3; FR-51, FR-52 |
| **Open signals and importance.** Blockers, incidents and open flags stay pinned in briefs until resolved; a transparent importance score decides what makes each brief | [Memory and journal v1](components/PRD-memory-journal-v1.md) 4 to 6; FR-53 to FR-55 |
| **Agent ergonomics.** Input aliases, errors with hints, and local response metering, at no token cost | [Briefs and search v4](components/PRD-briefs-search-v4.md) 6; FR-56 |

## 1. Summary

`ctxd` is a small, local-first context store that every AI agent I use can read from and write to over MCP. It gives Claude Code, Codex, Claude Desktop and other MCP clients one shared memory of my projects: what we decided, where work stands, the conventions to follow, and what the last session handed off.

It runs on my own Macs only, with a full replica on each machine. Replicas sync privately over Tailscale whenever they can reach each other. Nothing is exposed to the public internet.

The most important part of the product is not the database. It is **when agents read and write**. The [Hooks and agent lifecycle](components/PRD-hooks-v5.md) component PRD defines that in detail: lifecycle hooks load a compact brief when a session starts and capture a handoff when work ends, so continuity does not depend on an agent remembering to use a tool.

Alongside project knowledge, ctxd keeps **memory** about me (preferences and experience), **skills** (procedures every agent can follow) and a **journal** of what happened, and it can be browsed like a folder of Markdown files.

## 2. Problem

- **Every new session starts from zero.** I re-explain goals, conventions and status to each new chat or coding session.
- **Context is trapped per tool.** Claude's memory and past-chat search do not reach Codex, and Codex's context does not reach Claude. Switching tools (for a usage limit, a strength, or a second opinion) means pasting summaries by hand.
- **Sessions are fragile.** Two long-running sessions were lost around the September 29, 2026 outage. The knowledge built up in them went with them.
- **Agents duplicate and collide.** With no shared record of who is doing what, parallel agents repeat work or edit the same area.
- **Hosting it on the internet is not acceptable.** A cloud-hosted memory, even with IP filtering and OAuth, is an exposure I do not want.

## 3. Goals and non-goals

### Goals

1. **G1. Continuity across tools.** Any supported agent can start a session already knowing the project brief, current status, recent decisions and the last handoff.
2. **G2. Automatic, not aspirational.** Reads and writes at session boundaries happen through hooks wherever the client supports them. Agents do not have to remember.
3. **G3. Small and relevant reads.** Agents get a budgeted brief and targeted search results, never a dump. Shared context must save tokens, not spend them.
4. **G4. Local-first and private.** Every machine works fully offline. Data never leaves my machines except as part of prompts the agent itself sends to its model provider.
5. **G5. Trustworthy content.** Every entry records which agent, client, session and machine wrote it. Important agent-written content is proposed for my review before it is treated as settled.
6. **G6. Safe concurrency.** Two agents, or two machines, cannot silently overwrite each other.
7. **G7. Durable.** Losing a session, a chat, or one machine does not lose the project's accumulated knowledge.

### Non-goals (v1)

- Public or internet-reachable hosting of any kind, including tunnels and Tailscale Funnel.
- claude.ai web and mobile, and ChatGPT, as live clients. They connect from vendor clouds and cannot reach a private server. (A future, minimal mobile inbox is described in section 12.)
- Storing full chat transcripts. `ctxd` stores distilled knowledge: decisions, status, handoffs, conventions and pointers.
- Copying code or documents. Git remains the source of truth for code; `ctxd` stores pointers (paths, commit SHAs, URLs) and the reasoning git does not capture.
- Work data. No employer code, documents or context, and no installation on employer-managed devices.
- Multi-user or team features.

## 4. Users and surfaces

**Primary user:** me, working across personal projects in many tools.
**Machine users:** the agents, each with its own client identity and token.

| Surface | Connects how | Hooks available | Role in v1 |
|---|---|---|---|
| Claude Code (terminal, IDE, Desktop app "Code") | Local MCP over HTTP on `127.0.0.1` | Yes: full lifecycle | Primary |
| Codex CLI | Local MCP over HTTP on `127.0.0.1` | Yes: SessionStart, Stop, SessionEnd (rust-v0.145.0 and later), compaction, tool hooks | Primary |
| Claude Desktop chats (non-Code) | Local MCP via `claude_desktop_config.json` (stdio) | No | Secondary: instruction-driven |
| Gemini CLI, Cursor, VS Code | Local MCP | Varies; verify per client | Opportunistic |
| Phone | SSH over Tailscale into a Mac, then Claude Code or Codex there | Yes (it is Claude Code or Codex) | Secondary |
| Local model (future Mac Studio) | Local MCP | N/A | Future: private scopes, summarization |
| claude.ai web/mobile, ChatGPT | Not supported in v1 | N/A | Non-goal |

### Machines

| Machine | Role |
|---|---|
| MacBook Air (always on, at home) | Hub replica. Always reachable on the tailnet. Hosts home-only scopes. Target for phone SSH. |
| Main Mac (travels) | Full replica of the scopes it is allowed to hold. Works offline; syncs when connected. |
| Mac Studio (planned) | Takes over as hub; adds a local model. Migration is a data copy plus a name change. |

## 5. Core concepts

- **Scope:** a project or area of life (for example `ctxd`, `sample-app`, `notes`). Every entry belongs to exactly one scope. The global `_me` scope holds preferences and conventions that apply everywhere; `_me.<pool>` holds persona-specific ones.
- **Persona pool:** a named persona (for example `pool-dev`, `pool-notes`, `pool-private`) that grants a set of scopes to the agents assigned to it, each at `read`, `propose` or `write`. Agents in a pool share its context; nothing crosses pools unless a scope is placed in both.
- **Holding scope:** a private scope per agent where writes it is not allowed to place are held for my approval. Scopes carry two policies:
  - **replication:** `all` (every node), `home` (home nodes only, never the traveling laptop), or `local` (never leaves the node that wrote it);
  - **vendor policy:** `any` (cloud-model clients may read it) or `local-only` (only a local model may read it).
- **Entry:** one unit of knowledge, fully defined in the [Knowledge model](components/PRD-knowledge-model-v3.md). Each entry has a **kind**:

| Kind | Meaning | Example |
|---|---|---|
| `brief` | The pinned project summary; one per scope | "ctxd is a local-first context store. Goals..." |
| `status` | Where work stands right now | "Sync engine: pull path done, push path in progress" |
| `decision` | A choice that was made, with the reason | "Use an event log, not cr-sqlite, because cr-sqlite is dormant" |
| `convention` | A rule to follow | "All docs avoid em dashes" |
| `fact` | Something learned that is not a decision | "Codex reads the first 512 characters of server instructions most" |
| `lesson` | What went wrong or worked well, as advice for next time | "Run sync property tests with 2,000 cases; 500 missed the tombstone bug" |
| `handoff` | What the last session leaves for the next one | "Stopped mid-refactor of sync/apply.ts; tests failing on tombstones" |
| `task` | A unit of work that can be claimed, optionally with the paths it will write | "Implement FTS5 search" (paths `src/search/**`) |
| `pointer` | A link to something outside ctxd | "Commit 3fa2c1: add HLC clock" |
| `note` | Anything else worth keeping | |
| `preference` | How I like things done (memory) | "Prefers numbered document versions for each round of edits" |
| `skill` | A reusable procedure for agents, in `SKILL.md` form | "release-checklist: how to cut a release" |
| `journal` | A short record of something that happened, with a significance | "blocker: sealed pool tests need a Keychain stub" |

- **Status of an entry:** `active`, `proposed` (awaiting my review), `flagged`, `quarantined`, `superseded`, `archived`, `conflicted`.
- **Path:** a readable, stable address for every entry and folder, for example `ctxd://ctxd/decisions/use-an-event-log-7k2pqz.md`, interchangeable with its reference.
- **Open signal:** a blocker, incident, blocking task or open flag, pinned in briefs until resolved.
- **Brief:** a budgeted, deterministic assembly of a scope's most useful entries, in one of three sizes: `micro` (about 300 tokens), `normal` (about 1,500), `full` (about 4,000).
- **Client (agent):** an agent installation with its own token, for example `claude-code@air` or `codex@laptop`. Every write is attributed to a client. Clients belong to persona pools directly or by tag.
- **Claim (lease):** a time-limited statement that a client is working on a task. A claim may carry **write intent**, a list of repository-relative path patterns such as `src/sync/**`. Omitted write intent means "unknown"; an empty list means "this task writes no files."
- **Drift:** files a client changed under a claim that its declared write intent did not cover.

## 6. How ctxd works, and where each part is specified

This parent PRD sets the product's goals, scope and cross-cutting requirements. Each major part has its own **component PRD** that elaborates the parent requirements, adds component-level requirements (with their own ID prefixes) and links back here. The technical spec implements all of them.

### 6.1 Component PRDs

| Component PRD | Covers | Elaborates | Requirement prefix | Spec sections |
|---|---|---|---|---|
| [Knowledge model](components/PRD-knowledge-model-v3.md) | What is stored: scopes (including reserved `_me`, `_me.<pool>`, `_hold.<client>`), entry kinds (including `preference`, `skill`, `journal`), statuses, independently versioned parts, references and paths, relationships, history, review-by dates | FR-1, FR-3, FR-29 to FR-32 | KM- | 4, 4.1 to 4.3, 6, 8.2 |
| [Persona pools and access](components/PRD-pools-access-v2.md) | Who may see and write what: pools, grants, membership by client or tag, per-session personas and persona tokens, profiles, holding scopes, access requests, sealed pools, per-hop checks | FR-10, FR-16, FR-33 to FR-36, FR-42 | PA- | 4, 8.4, 10.5 to 10.7, 11 |
| [Hooks and agent lifecycle](components/PRD-hooks-v5.md) | **When agents read and write**: read moments R1 to R8, write moments W1 to W8 (including automatic journal entries), the Stop-hook nudge, per-client behavior, crash sweep, scope resolution, bypass, path guard, status line | FR-7, FR-8, FR-9, FR-27, FR-28 | HK- | 3, 8.1, 8.3, 9 |
| [Claims and write intent](components/PRD-claims-v3.md) | Task claims, write intent, overlap policy, drift audit, stale-claim takeover, claim liveness | FR-17, FR-23 to FR-26 | CL- | 4, 7.4, 7.5, 8.2 |
| [Trust and safety](components/PRD-trust-safety-v4.md) | Sanitization, capture filters, bypass, path guard, provenance, review queue and remembered approvals, tokens, vendor policy, network exposure, data at rest | FR-11, FR-12, FR-18, FR-21 | TS- | 6, 6.1, 9.9, 10 |
| [Context hygiene](components/PRD-context-hygiene-v1.md) | Cleaning bad context: flag, quarantine and revert by source, scope rollback, purge, review-by dates, tidy | FR-37 to FR-41 | CH- | 4, 7.6, 8.2, 11, 13 |
| [Replication and offline work](components/PRD-replication-v4.md) | Per-machine replicas, scope replication, sync over Tailscale, per-part conflicts, idempotent retries, hub migration | FR-4, FR-13 to FR-15 | RP- | 4, 5, 7, 12 |
| [Briefs and search](components/PRD-briefs-search-v4.md) | Detail tiers, brief contents and caps (including open signals, the skill catalog and journal highlights), lessons, interrupted-work wording, search scope and filters, tool footprint, agent ergonomics, semantic search | FR-2, FR-5, FR-6, FR-20, FR-56 | BS- | 8.2, 8.5, 11 |
| [Filesystem view](components/PRD-filesystem-view-v1.md) | `ctxd://` paths, folder summaries, browsing for agents and me, the editable Markdown mirror, import | FR-19, FR-43 to FR-45 | FS- | 4.2, 8.2, 12.1, 13 |
| [Skills](components/PRD-skills-v1.md) | Shared, versioned, approved procedures; the skill catalog; native sync into Claude Code and Codex | FR-46 to FR-49 | SK- | 4.3, 6, 10.4, 11.1, 12.2, 13 |
| [Memory and journal](components/PRD-memory-journal-v1.md) | Preferences and the `_me` layout; the journal, digests and time queries; open signals; importance; causal links | FR-50 to FR-55 | MJ- | 4.1, 4.3, 9.2, 11.1 to 11.5, 13 |
| Mobile inbox (future) | Section 12; becomes its own component PRD only if pursued | FR-22 | MI- | none yet |

Each component PRD lists its parent, its siblings and the spec sections that implement it. When a component changes, it gets a new numbered version, and this table is updated in the next parent version.

### 6.2 At a glance: when agents read and write

The full definition is in [Hooks and agent lifecycle](components/PRD-hooks-v5.md). In short:

- **Reads happen at session boundaries automatically.** Hooks inject a budgeted brief when a session starts, resumes, compacts or clears (R1 to R5). Agents search mid-session when they need history (R6), and Desktop chats load a brief through project instructions (R8).
- **Writes happen at session boundaries too.**
  - **Nudged handoff:** a Stop-hook nudge asks the agent for a handoff when meaningful work happened and none was written recently (W1).
  - **Mechanical records:** hooks record checkpoints, and journal entries for sessions and commits, with no model involvement (W2 to W4).
  - **Instruction-driven writes:** agents record decisions I confirm and claim or release tasks (W5, W6, W6b).
  - **Explicit saves:** "save this" always works (W7, W8).
- **Reliability ranking:** hooks first, then instructions, then explicit commands. Clients without hooks (Desktop chats) rely on the last two.

### 6.3 At a glance: who sees what, and cleaning up

- **Persona pools decide access, one persona per session.**
  - **Members:** each agent belongs to zero, one, several, or all pools.
  - **What it sees:** each session assumes one persona through a persona token, and reaches only that pool plus the global `_me`; its other pools are unreachable in that session.
  - **Agents in no pool:** they read the global `_me` and their writes are held privately for me.
  - **Writing into a pool requires my permission.** That means membership, a temporary grant, or approving an access request ([Persona pools and access](components/PRD-pools-access-v2.md)).
- **Bad context is easy to remove.**
  - **Any agent or I can flag an entry**, which pulls it from briefs at once.
  - **I can quarantine everything a misbehaving agent or session wrote**, then revert it or release it.
  - **I can roll a project back to a point in time.**
  - **I can purge content for real** when it must not survive anywhere ([Context hygiene](components/PRD-context-hygiene-v1.md)).

### 6.4 At a glance: memory, journal, skills and browsing

- **Memory about me lives in `_me`.** Preferences, conventions, profile facts and lessons, with per-persona versions in pool profiles. "Remember that..." in any session proposes one; every brief carries the most important.
- **The journal records what happened.** Hooks log sessions and commits; agents and I log milestones, blockers and incidents. Blockers stay pinned in briefs until something resolves them, and a weekly digest sums up each project.
- **Skills are shared procedures.** Approved once, available to every agent the persona allows, listed in briefs and fetched when needed.
- **Everything has a path.** Agents can browse folders as well as search; I can use `ctxd ls`, `tree` and `read`, or a Markdown mirror in my editor.

## 7. Functional requirements

| ID | Requirement | Priority | Detailed in |
|---|---|---|---|
| FR-1 | Store typed entries in scopes, with versions, tags, links and provenance (client, session, node, time) | P0 | [Knowledge](components/PRD-knowledge-model-v3.md) |
| FR-2 | MCP tools: `context_brief`, `context_search`, `context_get`, `context_write`, `context_handoff`, `context_flag`, `context_claim` | P0 | [Briefs](components/PRD-briefs-search-v4.md) |
| FR-3 | Optimistic concurrency: writes to an existing entry require `expected_rev`; mismatches return the current revision, never overwrite | P0 | [Knowledge](components/PRD-knowledge-model-v3.md) |
| FR-4 | Idempotent writes via a client-supplied `request_id` with an input fingerprint; reusing an id with different input is refused | P0 | [Replication](components/PRD-replication-v4.md) |
| FR-5 | Budgeted briefs at `micro`, `normal`, `full`, assembled deterministically (no model call) | P0 | [Briefs](components/PRD-briefs-search-v4.md) |
| FR-6 | Full-text search (SQLite FTS5) with ranking by relevance, recency and kind | P0 | [Briefs](components/PRD-briefs-search-v4.md) |
| FR-7 | `ctxd hook <event>` CLI for Claude Code and Codex hook events (Hooks section 7) | P0 | [Hooks](components/PRD-hooks-v5.md) |
| FR-8 | Stop-hook nudge rules and guards (Hooks section 6), configurable per scope | P0 | [Hooks](components/PRD-hooks-v5.md) |
| FR-9 | Scope resolution from the working directory through local bindings (repository identity or path mapping); nothing stored in repositories | P0 | [Hooks](components/PRD-hooks-v5.md) |
| FR-10 | Per-client tokens; every write attributed; tokens revocable | P0 | [Pools](components/PRD-pools-access-v2.md) |
| FR-11 | Review queue: `proposed` entries listed, approved, edited or rejected via `ctxd review` | P0 | [Trust](components/PRD-trust-safety-v4.md) |
| FR-12 | Redaction on write: strip `<private>` blocks; strip invisible and bidirectional control characters; reject likely secrets in agent writes; redact in place in mechanical hook captures; sanitize before truncating | P0 | [Trust](components/PRD-trust-safety-v4.md) |
| FR-13 | Multi-node replication over Tailscale with offline operation and convergence | P1 | [Replication](components/PRD-replication-v4.md) |
| FR-14 | Conflict policies by kind (spec section 7); conflicted entries surfaced in review | P1 | [Replication](components/PRD-replication-v4.md) |
| FR-15 | Scope replication policies (`all`, `home`, `local`) enforced during sync | P1 | [Replication](components/PRD-replication-v4.md) |
| FR-16 | Scope vendor policy (`any`, `local-only`) enforced per client on every read | P1 | [Pools](components/PRD-pools-access-v2.md) |
| FR-17 | Leases on tasks with expiry; tentative claims while offline; deterministic tie-break on merge | P1 | [Claims](components/PRD-claims-v3.md) |
| FR-18 | Encrypted backups (local, optionally copied to Google Drive as ciphertext) | P1 | [Trust](components/PRD-trust-safety-v4.md) |
| FR-19 | `ctxd export --markdown` for human-readable review and archiving; `ctxd import` of Markdown folders as proposed entries | P2 | [Trust](components/PRD-trust-safety-v4.md), [Filesystem view](components/PRD-filesystem-view-v1.md) |
| FR-20 | Semantic search (sqlite-vec with a local embedding model) blended with FTS | P2 | [Briefs](components/PRD-briefs-search-v4.md) |
| FR-21 | Signed events (per-node Ed25519) for tamper evidence | P2 | [Trust](components/PRD-trust-safety-v4.md) |
| FR-22 | Optional mobile inbox (section 12) | P3 | Section 12 |
| FR-23 | Claims accept optional write intent (`paths`), validated and normalized as repository-relative globs | P1 | [Claims](components/PRD-claims-v3.md) |
| FR-24 | Overlap detection between active claims in a scope, with intent policy `observe`, `warn` (default) or `strict`; overlaps from partitioned nodes surfaced after sync | P1 | [Claims](components/PRD-claims-v3.md) |
| FR-25 | Drift audit on release: changed files (agent-supplied or derived from session git records) compared with declared paths; drift recorded, briefed and reviewable; never modifies the repository | P1 | [Claims](components/PRD-claims-v3.md) |
| FR-26 | Facts-first stale claims: expired claims return `CLAIM_STALE` with holder, last activity, handoffs and commits since the claim; reclaim requires `take_over: true`; takeovers recorded and briefed | P1 | [Claims](components/PRD-claims-v3.md) |
| FR-27 | Hook adapters per client with a conformance kit of recorded fixtures per client version | P0 | [Hooks](components/PRD-hooks-v5.md) |
| FR-28 | Visibility: status line, `ctxd status`, optional sources-used card | P2 | [Hooks](components/PRD-hooks-v5.md) |
| FR-29 | `lesson` entry kind, proposed by default, surfaced by relevance | P1 | [Knowledge](components/PRD-knowledge-model-v3.md) |
| FR-30 | Stable, citable entry references that follow supersession | P1 | [Knowledge](components/PRD-knowledge-model-v3.md) |
| FR-31 | Typed relationships between entries, with one-hop retrieval and supersession notices | P1 | [Knowledge](components/PRD-knowledge-model-v3.md) |
| FR-32 | Full history with prior values per change; rejected writes and access denials recorded as metadata only | P0 | [Knowledge](components/PRD-knowledge-model-v3.md) |
| FR-33 | Persona pools: scope grants at `read`, `propose` or `write`; membership by client or tag; default deny; holding scopes for writes an agent may not place; access requests approved only by me | P0 | [Pools](components/PRD-pools-access-v2.md) |
| FR-34 | Global `_me` readable by every agent; optional `_me.<pool>` profiles | P0 | [Pools](components/PRD-pools-access-v2.md) |
| FR-35 | Each session assumes exactly one persona through a persona token, chosen from local bindings or `CTXD_POOL`; enforced on every call | P0 | [Pools](components/PRD-pools-access-v2.md) |
| FR-36 | Temporary, expiring grants | P1 | [Pools](components/PRD-pools-access-v2.md) |
| FR-37 | Flag entries as wrong, stale, duplicate or unsafe, by any agent or me; flagged entries leave briefs immediately | P0 | [Hygiene](components/PRD-context-hygiene-v1.md) |
| FR-38 | Quarantine by agent, session, time window and scope; revert or release, entirely or per entry | P1 | [Hygiene](components/PRD-context-hygiene-v1.md) |
| FR-39 | Scope rollback to a point in time | P1 | [Hygiene](components/PRD-context-hygiene-v1.md) |
| FR-40 | Purge: real erasure on every machine, including history and indexes, leaving an audited stub | P0 | [Hygiene](components/PRD-context-hygiene-v1.md) |
| FR-41 | Review-by dates and `ctxd tidy` | P1 | [Hygiene](components/PRD-context-hygiene-v1.md) |
| FR-42 | Sealed pools: separate encrypted file, Touch ID protected key, attached only for that persona, replicated only to enrolled machines | P1 | [Pools](components/PRD-pools-access-v2.md) |
| FR-43 | Stable `ctxd://` paths for entries and folders, with generated folder summaries, filtered by persona | P0 | [Filesystem view](components/PRD-filesystem-view-v1.md) |
| FR-44 | Paths accepted by `context_get` and `context_search`; CLI `ls`, `tree`, `read`, `grep`, `open` | P1 | [Filesystem view](components/PRD-filesystem-view-v1.md) |
| FR-45 | Optional two-way Markdown mirror for me, with revision checks; never for sealed pools or agents | P2 | [Filesystem view](components/PRD-filesystem-view-v1.md) |
| FR-46 | `skill` kind in `SKILL.md` form, scoped to `_me`, pool profiles or projects | P0 | [Skills](components/PRD-skills-v1.md) |
| FR-47 | Skill catalog in briefs; skills fetched on demand by name | P0 | [Skills](components/PRD-skills-v1.md) |
| FR-48 | Optional native sync of approved global skills into Claude Code and Codex skill folders | P1 | [Skills](components/PRD-skills-v1.md) |
| FR-49 | Agent-written skills always need my approval; flagged skills are withdrawn everywhere | P0 | [Skills](components/PRD-skills-v1.md) |
| FR-50 | `preference` kind; "remember that..." proposes memory; `ctxd remember` | P0 | [Memory and journal](components/PRD-memory-journal-v1.md) |
| FR-51 | `journal` kind with significance, written by hooks, agents and me | P0 | [Memory and journal](components/PRD-memory-journal-v1.md) |
| FR-52 | Weekly digest per scope; `since` and `until` search filters | P1 | [Memory and journal](components/PRD-memory-journal-v1.md) |
| FR-53 | Open signals pinned in briefs until resolved | P0 | [Memory and journal](components/PRD-memory-journal-v1.md) |
| FR-54 | Transparent importance score for ranking and tidy; never deletes | P1 | [Memory and journal](components/PRD-memory-journal-v1.md) |
| FR-55 | `caused` and `resolved` relations | P1 | [Memory and journal](components/PRD-memory-journal-v1.md) |
| FR-56 | Input aliases, error hints and local response metering, with no added tool tokens | P1 | [Briefs](components/PRD-briefs-search-v4.md) |

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | **No public exposure.** MCP listens on `127.0.0.1` only. Sync is reachable only on the tailnet via `tailscale serve`. Never `0.0.0.0`, never Funnel. |
| NFR-2 | **Offline-first.** Every read and write works with no network. |
| NFR-3 | **Fast.** Local tool calls p95 under 50 ms; hook commands under 300 ms; SessionEnd work under 1 second. |
| NFR-4 | **Small tool footprint.** All tool definitions together under about 1,500 tokens. |
| NFR-5 | **Convergence.** When nodes are connected, all eligible events replicate within 5 minutes. Partitioned writes are never lost. |
| NFR-6 | **Durability.** WAL mode; daily encrypted backup; restore tested. |
| NFR-7 | **Portability.** All state in one data directory plus one config file. Moving to a new machine is a copy plus a rename. |
| NFR-8 | **Privacy at rest.** FileVault required on every node; backups encrypted before leaving the machine. |
| NFR-9 | **Fail open for reads, fail safe for writes.** If ctxd is down, sessions proceed without context; writes are never silently dropped (the agent sees the error). |
| NFR-10 | **No partial state.** Each write is one transaction: the event, the materialized entry and the indexes all commit, or nothing does, and the caller gets an explicit error. Hook session-state files are written atomically (temporary file, then rename) under a per-session lock. |

## 9. Success metrics

- **Re-explaining drops.** In 4 weeks of use, at least 80% of sessions start with a brief and need no manual project recap.
- **Handoffs exist.** At least 90% of sessions that changed code end with a handoff (from W1) or at least a mechanical record (W2 or W3).
- **Tool switching is cheap.** Switching from Claude Code to Codex mid-task requires no pasted summary.
- **Low noise.** Fewer than 20% of proposed entries are rejected in review; briefs stay within budget.
- **No incidents.** Zero data loss across sync; zero network exposure findings.

## 10. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0** | PRD, spec, ADRs, repo scaffold | This document set approved |
| **M1** | Single-node core: knowledge model (parts, references, paths, relations, history, including preferences, skills and journal entries), event log, tools with aliases and error hints, FTS5 with path and time filters, tokens, persona pools and holding scopes, full redaction pipeline, flag and purge, metering | MCP tools work from Claude Code and Codex on one Mac, each seeing only its pools |
| **M2** | Hooks, claims and hygiene: quarantine, revert, release, access requests in review; hook adapters with conformance kit (Claude Code and Codex, including Codex SessionEnd), crash sweep, nudge rules, scope resolution from git origin, `_me` scope, bypass and path guard, claims with write intent, overlap, drift audit and stale-claim takeover, review CLI; journal entries from hooks, open signals, skill catalog, `remember`, `log`, `ls`, `tree` and `read` | A full day of work produces briefs and handoffs automatically; two agents on one Mac see each other's claims and overlaps |
| **M3** | Replication: sync protocol, conflict policies, scope replication, cross-node claim merge and overlap notices | Partition test suite passes; laptop and Air converge |
| **M4** | Air deployment: launchd, `tailscale serve`, backups, phone SSH, status line | Air runs unattended for 2 weeks |
| **M5** | Semantic search, Desktop chat integration, scope rollback, review-by dates and `ctxd tidy`, importance ranking, weekly digests, native skill sync | Hybrid search measurably better on a test set |
| **M6** | Signed events, Markdown export, Markdown mirror and import, Mac Studio migration with local model, sealed pools | Studio is the hub; local-only scopes served by a local model |
| **M7 (optional)** | Mobile inbox | Only if phone-chat capture proves needed |

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Agents ignore the store mid-session | Hooks for boundary reads and writes; short, consistent instructions; measure via success metrics |
| Stop-hook nudges annoy or cost too much | Rate limits, "nothing material" escape, per-scope switch |
| Noise and stale entries degrade reads | Typed entries, review queue, supersede links, budgets, periodic roll-up |
| Memory poisoning or prompt injection via stored text | Provenance on every entry, `proposed` status, retrieved text framed as data, instruction rule 5 |
| Sync bugs lose or duplicate data | Immutable event log, idempotent apply, partition tests before M3 exit |
| Lost laptop | FileVault, `home`-only scopes, per-node keys revocable |
| Old MacBook Air no longer receives macOS security updates | Tailnet-only exposure, ACLs; move hub to the Mac Studio when available |
| Vendor exposure: retrieved context is sent to the model provider | Vendor policy per scope; sensitive scopes `local-only` |
| Hook APIs change between client versions | One `ctxd hook` entry point; declared adapters per client; conformance fixtures per client version |
| Write intent is wrong or missing, so overlaps go unnoticed | Overlap detection is conservative; drift audit on release catches what intent missed; omitted intent is shown as "unknown" in briefs |
| Overlap warnings become noise and get ignored | Default `warn`, not `strict`; overlaps listed once per claim; per-scope policy |
| Hidden characters smuggle instructions past review | Invisible and bidirectional control characters stripped from all stored text |
| Sessions killed without an end hook leave claims and records dangling | Crash sweep at the next session start ([Hooks](components/PRD-hooks-v5.md) 7.1) |
| Briefs grow past what clients show inline | SessionStart cap of about 9,500 characters, enforced by test |
| Lessons encode a wrong habit that every agent then follows | Lessons are proposed by default, advisory only, and attributed |
| Bad context spreads before anyone notices | Any agent can flag; flags leave briefs at once; quarantine and revert by source ([Context hygiene](components/PRD-context-hygiene-v1.md)) |
| An over-trusted agent reads or writes everything | Persona pools with default deny; one persona per session via persona tokens; holding scopes and human-approved access requests ([Persona pools and access](components/PRD-pools-access-v2.md)) |
| Agents with shell access read ctxd's files directly | Path guard; client sandboxes; sealed pools for the most sensitive context |
| Real project names leak into the public record | No names in repositories: local bindings only; invented examples in all docs and tests |
| Pool setup becomes tedious | Tags for membership, pool default policies, `ctxd access` to explain effective access |
| Purge leaves copies in old backups | Backups expire in 14 days; optional backup rewrite on purge |
| Work data leaks into a personal tool | Non-goal; no install on employer devices; scope naming conventions |
| A bad skill steers every agent | Agent-written skills always need my approval and no rule can auto-accept them; provenance in the catalog; flagging withdraws a skill everywhere, including synced copies; synced skills never pre-approve tools ([Skills](components/PRD-skills-v1.md)) |
| The journal becomes noise | Automatic entries are `routine` and rank low; briefs show only highlights and open signals; weekly digests summarize |
| Memory about me reaches cloud vendors | Memory holds only what I would put in any prompt; anything sensitive belongs in a sealed pool |
| Mirror edits race agents' writes | Revision checks on every edit; conflicts become side files and review items, never silent overwrites |

## 12. Future: mobile inbox (out of scope for v1)

If capturing from phone chat apps proves important, add a minimal cloud inbox, not a mirror:

- **Writes only land in an inbox.** Phone chats write summaries there.
- **The hub empties it.** The Air pulls and deletes entries over an outbound connection; nothing connects into the home network.
- **Reads are limited.** At most an allowlisted set of non-sensitive briefs is ever pushed to the cloud.
- **Phone writes are quarantined.** Everything from the inbox arrives `proposed`.

## 13. Open questions

| # | Question |
|---|---|
| Q1 | MacBook Air model, chip and RAM; is it still on a supported macOS? (Decides local embeddings in M5.) |
| Q2 | Final project name and GitHub repo name (working name `ctxd`). |
| Q3 | Which scopes are `home`-only and which are `local-only`? |
| Q4 | Should confirmed decisions auto-accept in some scopes, or always go to review? |
| Q5 | Embedding model choice for M5 (local only). |
| Q6 | Run Beads alongside ctxd for task tracking, or keep tasks native? |
| Q7 | Default nudge thresholds (30 minutes, 20 turns) after a week of real use. |
| Q8 | Should ctxd integrate with coordinate-agents if I use it (for example, recording its review decisions and task results as pointers in ctxd), or stay independent? |
| Q9 | Default claim lease length (currently 120 minutes) and whether the Stop hook should auto-release claims when a session ends cleanly. |
| Q10 | Minimum supported client versions (Codex SessionEnd needs rust-v0.145.0; sources-used cards need a recent Claude Code). |
| Q11 | Should ctxd ever use a local model to write summaries or extract lessons automatically (M6), or stay curated only? |
| Q12 | Initial pool layout (which personas, which scopes in each, which agents where). The example in [Persona pools and access](components/PRD-pools-access-v2.md) section 4 is a starting point. |
| Q13 | Should repeated redaction rejections or flags from one agent quarantine it automatically ([Context hygiene](components/PRD-context-hygiene-v1.md) HQ2-2)? |
| Q14 | One Markdown mirror tree, or one per persona ([Filesystem view](components/PRD-filesystem-view-v1.md) FQ-1)? |
| Q15 | Journal retention: keep routine entries forever, or roll old ones into monthly digests ([Memory and journal](components/PRD-memory-journal-v1.md) MQ-2)? |
| Q16 | Allow skill supporting files (references, scripts) later, and under what review ([Skills](components/PRD-skills-v1.md) SQ-1)? |

## Appendix A: references

- Claude Code hooks reference: <https://code.claude.com/docs/en/hooks>
- Codex MCP configuration: <https://developers.openai.com/codex/mcp>
- Codex hooks after GA (community guide): <https://codex.danielvaughan.com/2026/05/25/codex-cli-hooks-after-ga-event-model-trust-verification-production-patterns/>
- Prior art survey: [prior-art-v4.md](../research/prior-art-v4.md)
- Claude Code skills: <https://code.claude.com/docs/en/skills>
- memory-journal-mcp: <https://github.com/neverinfamous/memory-journal-mcp>
- coordinate-agents: <https://github.com/hogancv/coordinate-agents>
- OpenWork: <https://github.com/different-ai/openwork>
- OpenViking: <https://github.com/volcengine/OpenViking>
- DataHub: <https://github.com/datahub-project/datahub>; context platform criteria: <https://datahub.com/blog/best-context-management-platform/>

## Appendix B: relationship to other projects

coordinate-agents and ctxd sit in different layers and can coexist:

| | coordinate-agents | ctxd |
|---|---|---|
| Purpose | Runs agents: planner, implementer and reviewer roles, task graphs, worktrees, terminal sessions, release gate | Remembers: decisions, status, conventions, handoffs and claims shared by every agent |
| Scope | One repository on one machine | All projects and areas, across machines |
| Storage | Plaintext files in the repository's `.agent-bus/` | SQLite event log per machine, replicated over Tailscale |
| Agent integration | Drives agent CLIs through terminal sessions | Hooks and MCP tools inside each agent's own session |

**Taken into ctxd:**

- write intent;
- overlap detection with policies;
- drift audit;
- facts-first stale claims;
- the stronger redaction set;
- hook adapter conformance;
- explicit write-failure semantics.

**Deliberately not taken:**

- **The large MCP tool surface (26 tools).** ctxd keeps 6, to protect agents' context windows.
- **Plaintext state inside the repository.** Neither its location nor its lack of encryption fits.
- **Terminal and PTY session management.**
- **Role-based workflow enforcement and the release gate.** These belong to an orchestrator.

The last two remain a useful reference for the separate autonomous-engineering work, not for ctxd.

### OpenWork

[OpenWork](https://github.com/different-ai/openwork) is an open-source desktop agent workspace (Electron and React) on top of the OpenCode engine, positioned as an alternative to Claude Cowork and Codex. Its "Den" control plane shares skills, plugins and MCP connections across a team through a hosted gateway. It has no typed, durable cross-agent context store, no per-client provenance, no write-intent claims and no peer replication, so it is **complementary**. ctxd could even run as a local MCP server inside an OpenWork workspace. Notably, its local server also binds to `127.0.0.1` and recommends `tailscale serve` for remote access, which matches ADR 0003.

**Taken into ctxd:**

- idempotency with input fingerprints;
- never replacing a corrupt store with an empty one;
- recovery-intent checkpoints and "verify before repeating side effects" wording;
- session activity states for claim liveness;
- read-only client tokens;
- remembered, narrow approval rules;
- sanitized exports with warnings.

**Deliberately not taken:**

- **The Den cloud control plane and public OAuth MCP gateway.** They conflict with ADR 0003.
- **Its source-available `ee/` features.**
- **The Electron UI and its OpenCode engine coupling.**
- **Auto-approval as a default.**

### OpenViking

[OpenViking](https://github.com/volcengine/OpenViking) is a self-hosted context database (AGPL-3.0). It organizes knowledge, memories and skills as a virtual filesystem with one-line, overview and full detail tiers, and ships hook-driven memory plugins for Claude Code, Codex and other agents. It binds to `127.0.0.1` by default and can use local models through Ollama.

**How it differs:** it is model-driven (every turn is captured and a model extracts memories), it runs as one primary server with asynchronous backups, and it has no claims, per-client provenance or review queue. It could be run alongside ctxd for automatic recall of conversation history, with ctxd holding the curated, reviewed layer.

**Taken into ctxd:**

- Corrected hook facts for Codex and Claude Code, and the crash sweep.
- Project identity from the git origin, and the `_me` scope.
- Detail tiers.
- Lessons.
- Cross-project search with a penalty.
- Bypass patterns, capture filters and the path guard.
- Status line and sources-used card.

- In v6: the filesystem view (`ctxd://` paths with one-line and overview folder summaries), user memories as preferences, and skills as shared context.

**Not taken:**

- **Automatic capture and model extraction of every turn.** It is noisy, and it sends more to model providers.
- **The filesystem as the storage model.** ctxd keeps typed entries as the source of truth and computes paths from them, so provenance, review, access and sync still work.
- **The single-primary storage.**
- **AGPL-licensed code.** Ideas only.

### memory-journal-mcp

[memory-journal-mcp](https://github.com/neverinfamous/memory-journal-mcp) is a single-user project journal and memory server over MCP, backed by SQLite, with a knowledge graph of entries.

**Taken into ctxd (v6):**

- the journal as its own kind, with significance;
- an importance score that explains itself;
- causal links (`caused`, `resolved`) and signals pinned until resolved;
- weekly digests;
- agent-friendly errors and alias coercion of enum inputs;
- response metering;
- a Markdown round trip for human editing.

**Not taken:** its large tool surface and team features, and any cloud sync.

### DataHub

[DataHub](https://github.com/datahub-project/datahub) (Apache-2.0) is an enterprise metadata platform and data catalog, now positioned as a context platform for data and AI, with an official MCP server.

**Taken into ctxd:**

- Independently versioned parts of an entry (aspects).
- Citable references (URNs).
- A change log carrying prior values.
- Records of rejected changes.
- Typed relationships.
- Its MCP hygiene: response budgets, and a token per caller.

**Not taken:** the platform itself. Kafka, OpenSearch, MySQL and Java services need 8 GB of RAM or more, and the quickstart binds to all interfaces, which conflicts with ADR 0003.

## Appendix C: ctxd against context-platform criteria

DataHub's [context management platform post](https://datahub.com/blog/best-context-management-platform/) (vendor marketing; its statistics are self-reported or sponsored) proposes eight criteria. How ctxd answers them at personal scale:

| Criterion | ctxd |
|---|---|
| 1. Breadth of ingestion | Not a goal; ctxd stores curated knowledge and pointers, not a data estate |
| 2. Metadata and semantic foundation | Typed kinds, parts, relations ([Knowledge model](components/PRD-knowledge-model-v3.md)) |
| 3. Expert-validated context | Proposed status and the review queue ([Trust and safety](components/PRD-trust-safety-v4.md)) |
| 4. Freshness through events | Hooks write at session boundaries; event-log sync ([Hooks](components/PRD-hooks-v5.md), [Replication](components/PRD-replication-v4.md)) |
| 5. Shareability across agents | Every MCP client, with hooks for Claude Code and Codex |
| 6. Activation beyond MCP | Hooks, CLI, Desktop project instructions |
| 7. Provenance, versioning, auditability | Per-client provenance, full history with prior values |
| 8. Open standards | MCP, SQLite, Markdown export and mirror, `SKILL.md` |

## Appendix D: notes for the work use case (out of scope for ctxd)

Kept here so the ideas are not lost; none of this applies to the personal ctxd design.

- **Govern context like data.** Treat agent context (conventions, decisions, runbooks) as governed entities with owners, domains and approval workflows, so what an agent saw is auditable the same way data access is.
- **A token per caller at the MCP layer.** No shared server tokens. Use short-lived, scoped tokens per agent run, with a policy decision on every tool call; this is an authorization-layer concern.
- **Reconstruct what an agent saw.** Version history plus provenance answers "what context drove this change," which matters for model risk and change management.
- **Domain-scoped retrieval.** Limit what context an agent can retrieve by domain or entitlement, enforced at retrieval time.
- **Persona pools map to entitlements.** ctxd's pools, `propose` level, holding scopes and human-approved access requests are a personal-scale version of role-based entitlements with just-in-time elevation and approval workflows. The same shape, backed by enterprise identity and policy, fits agent fleets at work.
- **Evaluate DataHub (or the existing catalog) as the enterprise context layer.** Do this rather than building one.

