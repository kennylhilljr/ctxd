# Prior Art: Shared Agent Memory and Local-First Sync (v2)

Status: research snapshot, 2026-10-16; updated 2026-10-17 (supersedes [v1](prior-art-v1.md))

**Changes in v2:** added [coordinate-agents](#coordinate-agents) and [OpenWork](#openwork), and the ideas adopted from each. The bottom line is unchanged.
Method: GitHub pages, PyPI, npm and project blogs, fetched 2026-10-16. Star counts are approximate. Where a release page showed no year, that is noted.

## Bottom line

Build `ctxd` and borrow heavily. No existing project combines everything we need:

- local-only, multi-writer replication across two or three machines;
- typed entries with optimistic concurrency and provenance;
- review and quarantine of agent-written content;
- budgeted briefs instead of dumps;
- lifecycle hooks for Claude Code and Codex.

The local-first tools do not replicate across machines. The tools that replicate depend on a vendor cloud (Cloudflare, Turso Cloud, a hosted service) or are too immature to depend on.

One pragmatic exception to evaluate: if task claims turn out to be a large share of the need, run Beads alongside `ctxd` for that slice (see Open question Q6 in the [PRD](../prd/PRD-v2.md)).

## Most relevant projects

| Project | What it is | Storage and search | Multi-agent | Cross-machine sync | License | Maintenance |
|---|---|---|---|---|---|---|
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | MCP knowledge base that humans and agents both edit | Markdown files as source of truth; SQLite index; hybrid full-text and vector search | Claude Desktop and Code, Codex, Cursor, VS Code | Paid cloud; otherwise DIY via Git or Syncthing | AGPL-3.0 | 0.23.2 on [PyPI, Aug 25 2026](https://pypi.org/project/basic-memory/) |
| [Beads](https://github.com/gastownhall/beads) | Git-native issue tracker and memory for agents | Dolt (versioned SQL) | Atomic claims, `bd ready`, hash IDs, [beads-mcp](https://pypi.org/project/beads-mcp/) | Dolt push and pull over a git remote; halts on conflict | MIT | beads-mcp 1.3.1, Oct 1 2026 |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Hook-driven auto-capture of session observations | SQLite FTS5 plus Chroma vectors | Claude Code, Codex, Gemini CLI, others | Optional cloud backup | Apache-2.0 | Active; recent npm releases |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | MCP and REST memory service | SQLite with sqlite-vec, or other backends | Many MCP clients | Hybrid mode syncs through Cloudflare | Apache-2.0 | 12.1.1 on [PyPI, Oct 16 2026](https://pypi.org/project/mcp-memory-service/) |
| [Graphiti](https://github.com/getzep/graphiti) | Temporal knowledge graph with an MCP server | Neo4j or FalkorDB; hybrid BM25, semantic and graph | Group management via MCP | Server database only | Apache-2.0 | graphiti-core 0.31.1, Oct 15 2026 |
| [ai-memory-mcp](https://github.com/alphaonedev/ai-memory-mcp) | Rust memory server with MCP, HTTP and CLI | SQLite, or Postgres with pgvector | `agent_id` on every memory, leases, signed writes, scoped namespaces | Peer federation with vector clocks and mTLS | Apache-2.0 | v0.9.0 (changelog 2026-07-08); low adoption |
| [global-agent-memory](https://github.com/ozankasikci/global-agent-memory) | Local-first memory for Claude Code and Codex | Markdown vault canonical; rebuildable SQLite FTS5 and sqlite-vec | Shared service; owner dashboard | None | MIT | v0.1.7; small project |
| [codex-agent-mem](https://github.com/MarceloCaporale/codex-agent-mem) | Compact "context packs" for coding agents | SQLite FTS5 | Multiple clients; read-only mode | None | Apache-2.0 | v1.0.2, 2026-05-07 |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Agent-to-agent mail plus file reservations | Git-stored Markdown; SQLite FTS5 index | Agent identities, inboxes, advisory file leases | Single HTTP server | License file present, type not confirmed | Active |
| [Serena memories](https://oraios.github.io/serena/02-usage/045_memories.html) | Memory feature in a coding-agent MCP toolkit | Markdown in `.serena/memories/` | Any MCP client | Through git, project scope only | MIT | serena-agent 2.0.0, Oct 13 2026 |
| [Letta Code](https://github.com/letta-ai/letta-code) | Stateful agent harness | Memory blocks tracked in git | Cross-agent message search | Git sync to a remote | Apache-2.0 | letta 0.34.12, Oct 12 2026 |
| [coordinate-agents](https://github.com/hogancv/coordinate-agents) | Local orchestration runtime: Codex plans and reviews, an implementer CLI codes | Plaintext files in each repo's `.agent-bus/` (atomic rename claims, leases, append-only JSONL journal) | Planner, implementer and reviewer roles; adapters for Codex, Antigravity and generic CLIs | None (single machine, per repo) | MIT | Very active; latest commit 2026-10-16 |
| [OpenWork](https://github.com/different-ai/openwork) | Desktop agent workspace on OpenCode; "Den" team control plane | Local SQLite; hosted MySQL for Den | Cross-session search and read; team skill and connection sharing | Cloud-to-desktop config snapshots, not peer replication | MIT core; `ee/` source-available | Very active; latest commit 2026-10-17 |
| [MCP reference memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | Minimal knowledge-graph MCP server | One JSONL file | No concurrency control | None | MIT | Reference baseline only |

**Dropped or demoted:** OpenMemory MCP (folded into Mem0's self-hosted server; Mem0 is cloud and LLM-extraction centered), ByteRover/Cipher (archived Sep 2026, Elastic License), Cognee (heavy graph-RAG pipeline), Supermemory (MCP is cloud-hosted), memory-bank-mcp (plain files, no search or sync).

## Ideas adopted into the PRD and spec

| Idea | Source | Where it lands in ctxd |
|---|---|---|
| Lifecycle hooks drive reads and writes | claude-mem | PRD section 6; SPEC section 9 |
| Progressive disclosure: search, then fetch | claude-mem | `context_search` returns previews; `context_get` fetches bodies |
| Budgeted packs (micro, normal, full) | codex-agent-mem | `context_brief` budget levels |
| Agent writes become *proposals* the owner approves | global-agent-memory | `proposed` status and `ctxd review` |
| Protection tiers with audited unlocks | global-agent-memory, Serena | Scope `vendor_policy` and `replication` |
| Supersede instead of delete; facts are invalidated, not erased | Graphiti, global-agent-memory | `supersedes` links and tombstones |
| Every fact traces back to its source | Graphiti | `client_id`, `session_id`, `node_id` on every event |
| `agent_id` on every write, scoped namespaces | ai-memory-mcp | Per-client tokens and scopes |
| Signed writes with an audit chain | ai-memory-mcp | Deferred to milestone M6 (signed events) |
| Hash or ULID IDs so offline writers never collide | Beads | ULID entry and event IDs |
| Atomic claims with deterministic tie-break | Beads, MCP Agent Mail | `context_claim` with leases |
| Sync halts and surfaces conflicts instead of guessing | Beads | Conflict policies by entry kind |
| `<private>` exclusion markers | claude-mem, Serena | Redaction pass on write |
| Human-readable export | Basic Memory | `ctxd export --markdown` |

| Write intent on claims (repository-relative globs) | coordinate-agents Intent Map | [Claims PRD](../prd/components/PRD-claims-v1.md) 4; Spec 7.5.1 |
| Conservative, deterministic overlap test and `observe`/`warn`/`strict` policy | coordinate-agents | Claims PRD 5; Spec 7.5.2 and 7.5.3 |
| Post-release drift audit that never modifies the repository | coordinate-agents scope audit | Claims PRD 6; Spec 7.5.4 |
| Stale claims require facts before takeover | coordinate-agents recovery rule | Claims PRD 7; Spec 7.5.5 |
| Broader redaction set; strip invisible and bidirectional characters; sanitize before truncating | coordinate-agents | [Trust and safety PRD](../prd/components/PRD-trust-safety-v1.md) 3; Spec 6.1 and 10.3 |
| Declared client adapters with a conformance kit | coordinate-agents Adapter Contract | [Hooks PRD](../prd/components/PRD-hooks-v1.md) 7; Spec 9.7 |
| Request input fingerprints: same id with different input is refused | OpenWork remote-sessions journal | [Replication PRD](../prd/components/PRD-replication-v1.md) RP-6; Spec 6 |
| Never replace a corrupt store with an empty one | OpenWork remote-sessions journal | Trust and safety TS-10; Spec 12 |
| Recovery intent without content; "verify before repeating side effects" | OpenWork task recovery | Hooks HK-13; [Briefs PRD](../prd/components/PRD-briefs-search-v1.md) BS-3; Spec 11.1 |
| Session activity states for liveness | OpenWork session activity | Claims CL-12; Spec 9.2 |
| Read-only client tokens | OpenWork token scopes | Trust and safety 6; Spec 10.4 |
| Remembered, narrow approval rules | OpenWork per-thread approvals | Trust and safety 5; Spec 10.4 |
| Export sanitization with categorized warnings | OpenWork export safety | Trust and safety 3; Spec 13 |

## coordinate-agents

A local runtime where Codex clarifies and reviews while a configured implementer CLI writes code. The pieces:

- **Agent Bus.** A file-based bus with atomic claiming, leases, dedupe keys and quarantine.
- **Task Graphs.** Parallel git worktrees, a separate integration review, and an explicit release gate.
- **Event journal.** An append-only JSONL journal for observability.
- **MCP server.** 26 tools.

It coordinates **execution**; ctxd provides **context**. The two are complementary.

**Not taken:**

- **The 26-tool surface.** It is too heavy for agent context windows.
- **Plaintext state stored inside each repository.**
- **Terminal and PTY session management.**
- **Role enforcement and the release gate.** These belong to an orchestrator. They remain a reference for the separate autonomous-engineering work.

## OpenWork

A desktop agent workspace (Electron and React) on the OpenCode engine, positioned as an open alternative to Claude Cowork and Codex. Its parts:

- **Local server.** It binds to `127.0.0.1` and recommends `tailscale serve` for remote access, the same posture as ADR 0003.
- **Den.** A hosted or self-hosted control plane with a remote MCP gateway that pushes skills, plugins and connections into Claude Code, Codex and Cursor.
- **Cross-session reading.** Sessions can search and read other sessions' transcripts.

There is no typed, durable cross-agent knowledge store, no per-client provenance, no write-intent claims and no peer replication, so it is complementary. Its most transferable value is reliability engineering in `packages/remote-sessions` and `task-recovery.ts`.

**Not taken:**

- **The Den cloud control plane, marketplaces and public OAuth MCP gateway.** They conflict with ADR 0003.
- **The source-available `ee/` features.**
- **The Electron UI and the OpenCode engine coupling.**
- **Auto-approval as a default.**

## Anti-patterns to avoid

- **Auto-capturing everything.** Volume overwhelms signal; reads get noisy and stale.
- **Syncing a live SQLite file** with Syncthing, iCloud, Dropbox or Drive. It corrupts or silently loses writes.
- **Single-file stores without concurrency control** (the MCP reference server).
- **Sync through a vendor cloud.** It violates the no-public-internet constraint.

## Sync-engine options

| Option | Fit | Notes |
|---|---|---|
| **Typed append-only event log (custom)** | **Chosen** | Immutable events with ULIDs make replication a set union; semantic conflicts are surfaced by policy. |
| SQLite session extension | Fallback | Stable and built in. Captures changesets by primary key with a conflict handler. Virtual tables (FTS5, vec) are not captured, so indexes are rebuilt locally anyway. |
| cr-sqlite | Not chosen | Elegant CRDT design, but effectively dormant since late 2024. |
| Automerge | Not chosen | Per-document CRDT. Only useful for rich-text fields. |
| Dolt | Not chosen | Cell-level merge, but MySQL dialect, and multi-writer needs a server. |
| Turso offline sync | Not chosen | Targets Turso Cloud; beta detects but does not resolve conflicts. |
| LiteFS, Litestream | Not chosen | Single writer only. Litestream remains useful for backups. |
| Electric, PowerSync | Not chosen | Sync clients against a central backend database. |
| Raft stores (rqlite, dqlite) | Not chosen | Need a majority to write; two nodes cannot form one during a partition. |
