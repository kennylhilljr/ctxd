# ctxd: Shared Context for AI Agents (PRD v2)

| | |
|---|---|
| **Status** | Draft v2 |
| **Owner** | Kenny Hill |
| **Date** | 2026-10-17 |
| **Supersedes** | [PRD v1](PRD-v1.md) |
| **Component PRDs** | [Hooks](components/PRD-hooks-v1.md), [Claims](components/PRD-claims-v1.md), [Trust and safety](components/PRD-trust-safety-v1.md), [Replication](components/PRD-replication-v1.md), [Briefs and search](components/PRD-briefs-search-v1.md) |
| **Companion docs** | [Technical spec v2](../spec/SPEC-v2.md), [Prior art v2](../research/prior-art-v2.md), [ADRs](../adr/) |

## Changes in v2

**Structure.** v2 splits the product into this **parent PRD** plus five **component PRDs** (section 6.1). The parent keeps the vision, goals, scope, cross-cutting requirements, milestones and risks. Each component PRD elaborates its parent requirements with its own requirement IDs, acceptance criteria and open questions, and references its parent, its siblings and the spec sections that implement it.

**Content.** v2 adopts selected mechanisms from two projects reviewed on 2026-10-17. Neither one is a shared context store; Appendix B lists what was deliberately left out.

- **[coordinate-agents](https://github.com/hogancv/coordinate-agents)** (MIT): a local Codex-plus-implementer orchestration runtime.
- **[OpenWork](https://github.com/different-ai/openwork)** (MIT core): a desktop agent workspace built on OpenCode.

| Change | Detailed in | Source |
|---|---|---|
| Task claims can declare **write intent**: the file paths an agent expects to touch | [Claims](components/PRD-claims-v1.md) 4; FR-23 | coordinate-agents Intent Map |
| **Overlap detection** between active claims, with a per-scope policy (`observe`, `warn`, `strict`) | [Claims](components/PRD-claims-v1.md) 5; FR-24 | coordinate-agents scheduling and `scopePolicy` |
| **Drift audit** when a claim is released | [Claims](components/PRD-claims-v1.md) 6; FR-25 | coordinate-agents scope audit |
| **Facts-first stale claims**, including the holder session's last known state | [Claims](components/PRD-claims-v1.md) 7; FR-26 | coordinate-agents recovery rule; OpenWork session activity states |
| **Stronger sanitization**: cookies, authorization headers, bearer tokens, URL credentials, invisible and bidirectional characters; sanitize before truncating; scrubbed exports with warnings | [Trust and safety](components/PRD-trust-safety-v1.md) 3; FR-12 | coordinate-agents redaction set; OpenWork export safety |
| **Read-only client tokens** and **remembered approval rules** in review | [Trust and safety](components/PRD-trust-safety-v1.md) 5 and 6 | OpenWork token scopes and per-thread approvals |
| **Hook adapter conformance kit** | [Hooks](components/PRD-hooks-v1.md) 7; FR-27 | coordinate-agents Adapter Conformance Kit |
| **Recovery-intent checkpoints** and interrupted-work wording in briefs | [Hooks](components/PRD-hooks-v1.md) HK-13; [Briefs](components/PRD-briefs-search-v1.md) 2 | OpenWork task recovery |
| **Idempotency with input fingerprints**: a retry reusing a request id with different content is refused | [Replication](components/PRD-replication-v1.md) RP-6; FR-4 | OpenWork remote-sessions journal |
| **Explicit failure semantics**; never replace a corrupt database with an empty one | NFR-10; [Trust and safety](components/PRD-trust-safety-v1.md) TS-10 | coordinate-agents journal rules; OpenWork journal rules |

## 1. Summary

`ctxd` is a small, local-first context store that every AI agent I use can read from and write to over MCP. It gives Claude Code, Codex, Claude Desktop and other MCP clients one shared memory of my projects: what we decided, where work stands, the conventions to follow, and what the last session handed off.

It runs on my own Macs only, with a full replica on each machine. Replicas sync privately over Tailscale whenever they can reach each other. Nothing is exposed to the public internet.

The most important part of the product is not the database. It is **when agents read and write**. The [Hooks and agent lifecycle](components/PRD-hooks-v1.md) component PRD defines that in detail: lifecycle hooks load a compact brief when a session starts and capture a handoff when work ends, so continuity does not depend on an agent remembering to use a tool.

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
| Codex CLI | Local MCP over HTTP on `127.0.0.1` | Yes: SessionStart, Stop, compaction, tool hooks | Primary |
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

- **Scope:** a project or area of life (for example `ctxd`, `sample-app`, `notes`). Every entry belongs to exactly one scope. Scopes carry two policies:
  - **replication:** `all` (every node), `home` (home nodes only, never the traveling laptop), or `local` (never leaves the node that wrote it);
  - **vendor policy:** `any` (cloud-model clients may read it) or `local-only` (only a local model may read it).
- **Entry:** one unit of knowledge. Each entry has a **kind**:

| Kind | Meaning | Example |
|---|---|---|
| `brief` | The pinned project summary; one per scope | "ctxd is a local-first context store. Goals..." |
| `status` | Where work stands right now | "Sync engine: pull path done, push path in progress" |
| `decision` | A choice that was made, with the reason | "Use an event log, not cr-sqlite, because cr-sqlite is dormant" |
| `convention` | A rule to follow | "All docs avoid em dashes" |
| `fact` | Something learned that is not a decision | "Codex reads the first 512 characters of server instructions most" |
| `handoff` | What the last session leaves for the next one | "Stopped mid-refactor of sync/apply.ts; tests failing on tombstones" |
| `task` | A unit of work that can be claimed, optionally with the paths it will write | "Implement FTS5 search" (paths `src/search/**`) |
| `pointer` | A link to something outside ctxd | "Commit 3fa2c1: add HLC clock" |
| `note` | Anything else worth keeping | |

- **Status of an entry:** `active`, `proposed` (awaiting my review), `superseded`, `archived`, `conflicted`.
- **Brief:** a budgeted, deterministic assembly of a scope's most useful entries, in one of three sizes: `micro` (about 300 tokens), `normal` (about 1,500), `full` (about 4,000).
- **Client:** an agent installation with its own token, for example `claude-code@air` or `codex@laptop`. Every write is attributed to a client.
- **Claim (lease):** a time-limited statement that a client is working on a task. A claim may carry **write intent**, a list of repository-relative path patterns such as `src/sync/**`. Omitted write intent means "unknown"; an empty list means "this task writes no files."
- **Drift:** files a client changed under a claim that its declared write intent did not cover.

## 6. How ctxd works, and where each part is specified

This parent PRD sets the product's goals, scope and cross-cutting requirements. Each major part has its own **component PRD** that elaborates the parent requirements, adds component-level requirements (with their own ID prefixes) and links back here. The technical spec implements all of them.

### 6.1 Component PRDs

| Component PRD | Covers | Elaborates | Requirement prefix | Spec sections |
|---|---|---|---|---|
| [Hooks and agent lifecycle](components/PRD-hooks-v1.md) | **When agents read and write**: read moments R1 to R8, write moments W1 to W8, the Stop-hook nudge, per-client behavior, hook adapters and conformance, agent instructions | FR-7, FR-8, FR-9, FR-27 | HK- | 8.1, 8.3, 9 |
| [Claims and write intent](components/PRD-claims-v1.md) | Task claims, write intent, overlap policy, drift audit, stale-claim takeover, claim liveness | FR-17, FR-23 to FR-26 | CL- | 4, 7.4, 7.5, 8.2 |
| [Trust and safety](components/PRD-trust-safety-v1.md) | Sanitization and redaction, provenance, review queue and remembered approvals, client tokens and access levels, vendor policy, network exposure, data at rest | FR-10 to FR-12, FR-16, FR-18, FR-21 | TS- | 6, 6.1, 10 |
| [Replication and offline work](components/PRD-replication-v1.md) | Per-machine replicas, scope replication, sync over Tailscale, conflicts, idempotent retries, hub migration | FR-4, FR-13 to FR-15 | RP- | 4, 5, 7, 12 |
| [Briefs and search](components/PRD-briefs-search-v1.md) | Brief sizes and contents, interrupted-work wording, search and fetch, tool footprint, semantic search | FR-2, FR-5, FR-6, FR-20 | BS- | 8.2, 11 |
| Mobile inbox (future) | Section 12; becomes its own component PRD only if pursued | FR-22 | MI- | none yet |

Each component PRD lists its parent, its siblings and the spec sections that implement it. When a component changes, it gets a new numbered version, and this table is updated in the next parent version.

### 6.2 At a glance: when agents read and write

The full definition is in [Hooks and agent lifecycle](components/PRD-hooks-v1.md). In short:

- **Reads happen at session boundaries automatically.** Hooks inject a budgeted brief when a session starts, resumes, compacts or clears (R1 to R5). Agents search mid-session when they need history (R6), and Desktop chats load a brief through project instructions (R8).
- **Writes happen at session boundaries too.**
  - **Nudged handoff:** a Stop-hook nudge asks the agent for a handoff when meaningful work happened and none was written recently (W1).
  - **Mechanical records:** hooks record checkpoints, session logs and commits with no model involvement (W2 to W4).
  - **Instruction-driven writes:** agents record decisions I confirm and claim or release tasks (W5, W6, W6b).
  - **Explicit saves:** "save this" always works (W7, W8).
- **Reliability ranking:** hooks first, then instructions, then explicit commands. Clients without hooks (Desktop chats) rely on the last two.

## 7. Functional requirements

| ID | Requirement | Priority | Detailed in |
|---|---|---|---|
| FR-1 | Store typed entries in scopes, with versions, tags, links and provenance (client, session, node, time) | P0 | [Trust](components/PRD-trust-safety-v1.md) |
| FR-2 | MCP tools: `context_brief`, `context_search`, `context_get`, `context_write`, `context_handoff`, `context_claim` | P0 | [Briefs](components/PRD-briefs-search-v1.md) |
| FR-3 | Optimistic concurrency: writes to an existing entry require `expected_rev`; mismatches return the current revision, never overwrite | P0 | Spec 6 |
| FR-4 | Idempotent writes via a client-supplied `request_id` with an input fingerprint; reusing an id with different input is refused | P0 | [Replication](components/PRD-replication-v1.md) |
| FR-5 | Budgeted briefs at `micro`, `normal`, `full`, assembled deterministically (no model call) | P0 | [Briefs](components/PRD-briefs-search-v1.md) |
| FR-6 | Full-text search (SQLite FTS5) with ranking by relevance, recency and kind | P0 | [Briefs](components/PRD-briefs-search-v1.md) |
| FR-7 | `ctxd hook <event>` CLI for Claude Code and Codex hook events (Hooks section 7) | P0 | [Hooks](components/PRD-hooks-v1.md) |
| FR-8 | Stop-hook nudge rules and guards (Hooks section 6), configurable per scope | P0 | [Hooks](components/PRD-hooks-v1.md) |
| FR-9 | Scope resolution from the working directory (git root, git remote, or a `.ctxd.toml` file) | P0 | [Hooks](components/PRD-hooks-v1.md) |
| FR-10 | Per-client tokens; every write attributed; tokens revocable | P0 | [Trust](components/PRD-trust-safety-v1.md) |
| FR-11 | Review queue: `proposed` entries listed, approved, edited or rejected via `ctxd review` | P0 | [Trust](components/PRD-trust-safety-v1.md) |
| FR-12 | Redaction on write: strip `<private>` blocks; strip invisible and bidirectional control characters; reject likely secrets in agent writes; redact in place in mechanical hook captures; sanitize before truncating | P0 | [Trust](components/PRD-trust-safety-v1.md) |
| FR-13 | Multi-node replication over Tailscale with offline operation and convergence | P1 | [Replication](components/PRD-replication-v1.md) |
| FR-14 | Conflict policies by kind (spec section 7); conflicted entries surfaced in review | P1 | [Replication](components/PRD-replication-v1.md) |
| FR-15 | Scope replication policies (`all`, `home`, `local`) enforced during sync | P1 | [Replication](components/PRD-replication-v1.md) |
| FR-16 | Scope vendor policy (`any`, `local-only`) enforced per client on every read | P1 | [Trust](components/PRD-trust-safety-v1.md) |
| FR-17 | Leases on tasks with expiry; tentative claims while offline; deterministic tie-break on merge | P1 | [Claims](components/PRD-claims-v1.md) |
| FR-18 | Encrypted backups (local, optionally copied to Google Drive as ciphertext) | P1 | [Trust](components/PRD-trust-safety-v1.md) |
| FR-19 | `ctxd export --markdown` for human-readable review and archiving | P2 | [Trust](components/PRD-trust-safety-v1.md) |
| FR-20 | Semantic search (sqlite-vec with a local embedding model) blended with FTS | P2 | [Briefs](components/PRD-briefs-search-v1.md) |
| FR-21 | Signed events (per-node Ed25519) for tamper evidence | P2 | [Trust](components/PRD-trust-safety-v1.md) |
| FR-22 | Optional mobile inbox (section 12) | P3 | Section 12 |
| FR-23 | Claims accept optional write intent (`paths`), validated and normalized as repository-relative globs | P1 | [Claims](components/PRD-claims-v1.md) |
| FR-24 | Overlap detection between active claims in a scope, with intent policy `observe`, `warn` (default) or `strict`; overlaps from partitioned nodes surfaced after sync | P1 | [Claims](components/PRD-claims-v1.md) |
| FR-25 | Drift audit on release: changed files (agent-supplied or derived from session git records) compared with declared paths; drift recorded, briefed and reviewable; never modifies the repository | P1 | [Claims](components/PRD-claims-v1.md) |
| FR-26 | Facts-first stale claims: expired claims return `CLAIM_STALE` with holder, last activity, handoffs and commits since the claim; reclaim requires `take_over: true`; takeovers recorded and briefed | P1 | [Claims](components/PRD-claims-v1.md) |
| FR-27 | Hook adapters per client with a conformance kit of recorded fixtures per client version | P0 | [Hooks](components/PRD-hooks-v1.md) |

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
| **M1** | Single-node core: store, event log, tools, FTS5, tokens, full redaction pipeline | MCP tools work from Claude Code and Codex on one Mac |
| **M2** | Hooks and claims: hook adapters with conformance kit, nudge rules, scope resolution, claims with write intent, overlap, drift audit and stale-claim takeover, review CLI | A full day of work produces briefs and handoffs automatically; two agents on one Mac see each other's claims and overlaps |
| **M3** | Replication: sync protocol, conflict policies, scope replication, cross-node claim merge and overlap notices | Partition test suite passes; laptop and Air converge |
| **M4** | Air deployment: launchd, `tailscale serve`, backups, phone SSH | Air runs unattended for 2 weeks |
| **M5** | Semantic search and Desktop chat integration | Hybrid search measurably better on a test set |
| **M6** | Signed events, Markdown export, Mac Studio migration with local model | Studio is the hub; local-only scopes served by a local model |
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
| Work data leaks into a personal tool | Non-goal; no install on employer devices; scope naming conventions |

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

## Appendix A: references

- Claude Code hooks reference: <https://code.claude.com/docs/en/hooks>
- Codex MCP configuration: <https://developers.openai.com/codex/mcp>
- Codex hooks after GA (community guide): <https://codex.danielvaughan.com/2026/05/25/codex-cli-hooks-after-ga-event-model-trust-verification-production-patterns/>
- Prior art survey: [prior-art-v2.md](../research/prior-art-v2.md)
- coordinate-agents: <https://github.com/hogancv/coordinate-agents>
- OpenWork: <https://github.com/different-ai/openwork>

## Appendix B: relationship to coordinate-agents and OpenWork

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

