# Prior Art: Shared Agent Memory and Local-First Sync (v1)

Status: research snapshot, 2026-10-16
Method: GitHub pages, PyPI, npm and project blogs, fetched 2026-10-16. Star counts are approximate. Where a release page showed no year, that is noted.

## Bottom line

Build `ctxd` and borrow heavily. No existing project combines everything we need:

- local-only, multi-writer replication across two or three machines;
- typed entries with optimistic concurrency and provenance;
- review and quarantine of agent-written content;
- budgeted briefs instead of dumps;
- lifecycle hooks for Claude Code and Codex.

The local-first tools do not replicate across machines. The tools that replicate depend on a vendor cloud (Cloudflare, Turso Cloud, a hosted service) or are too immature to depend on.

One pragmatic exception to evaluate: if task claims turn out to be a large share of the need, run Beads alongside `ctxd` for that slice (see Open question Q6 in the PRD).

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
