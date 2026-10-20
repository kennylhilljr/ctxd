# ctxd Component PRD: Briefs and Search (v5)

| | |
|---|---|
| **Status** | Draft v5 |
| **Date** | 2026-10-20 |
| **Supersedes** | [v4](PRD-briefs-search-v4.md) |
| **Parent** | [ctxd PRD v8](../PRD-v8.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v4.md), [Persona pools and access](PRD-pools-access-v3.md), [Hooks and agent lifecycle](PRD-hooks-v6.md), [Claims and write intent](PRD-claims-v4.md), [Trust and safety](PRD-trust-safety-v5.md), [Context hygiene](PRD-context-hygiene-v2.md), [Replication](PRD-replication-v6.md), [Filesystem view](PRD-filesystem-view-v2.md), [Skills](PRD-skills-v3.md), [Memory and journal](PRD-memory-journal-v2.md) |
| **Spec** | [Spec v10](../../spec/SPEC-v10.md) (HLD) sections 8.2, 8.5 and 11; detail in [LLD: Briefs and search](../../lld/LLD-briefs-search-v1.md), [Contract: MCP tools](../../contracts/mcp-tools-v1.md) |
| **Acceptance tests** | [Test plan v1](../../test/test-plan-v1.md), BS section |
| **Parent requirements elaborated** | FR-2, FR-5, FR-6, FR-20, FR-47, FR-52 to FR-54, FR-56; NFR-4 |
| **Adapted from** | codex-agent-mem budgeted packs; claude-mem progressive disclosure; [OpenWork](https://github.com/different-ai/openwork) search-then-read and recovery wording; [OpenViking](https://github.com/volcengine/OpenViking) L0/L1/L2 context tiers, experience memory and cross-project recall with a penalty; [memory-journal-mcp](https://github.com/neverinfamous/memory-journal-mcp) importance scoring, pinned signals, agent-friendly errors with alias coercion, and response metering |

## Changes in v5

Earlier changes are listed in [v4](PRD-briefs-search-v4.md) and before.

- **Acceptance criteria in EARS, with IDs.** Every criterion is now one EARS statement with an ID (`BS-AC-n`) and the component requirements it verifies. The meaning of each v4 criterion is unchanged; compound criteria were split so each states one response, and criteria the spec's test table already assumed were made explicit. Each ID is mapped to its tests, or marked as a gap, in the [test plan](../../test/test-plan-v1.md).
- **Links.** The header points to PRD v8, Spec v10 (now the system HLD) and this component's LLD; sibling links point to current versions.

## 1. Purpose

Shared context must save tokens, not spend them. This component defines what agents receive when they read: a compact brief at the start of work, and small, ranked search results with full entries only on request.

## 2. Briefs

A brief is a deterministic summary of a scope, assembled without a model call, in one of three sizes:

| Size | About | Used for |
|---|---|---|
| `micro` | 300 tokens | Resume, compaction, `/clear`, subagents |
| `normal` | 1,500 tokens | New sessions and chats |
| `full` | 4,000 tokens | When I or an agent asks for depth |

### 2.1 Three tiers of detail

Everything in ctxd can be read at three levels, so agents judge relevance before paying for detail:

| Tier | What | Typical size | Where it appears |
|---|---|---|---|
| **Summary** | One line per entry; one line per scope | Up to 200 characters | Search results, brief lists, claim notices |
| **Overview** | The scope's pinned brief entry; an entry's first paragraph | Up to about 4,000 characters | Briefs |
| **Full** | The complete entry | Up to the entry size limit | `context_get` only |

Folders in the filesystem view have the same tiers: a one-line `.abstract` and an `.overview` ([Filesystem view](PRD-filesystem-view-v2.md)).

Agents may write the summary line themselves; otherwise ctxd takes the first sentence of the body. No model is required. With the Mac Studio's local model (M6), ctxd can optionally improve summaries and scope overviews, marked as machine-written.

### 2.2 Lessons

A `lesson` records what went wrong or worked unusually well on a kind of task, for example: "Running the sync property tests with fewer than 500 runs missed the tombstone bug; use 2,000." Lessons are:

- **Captured** through the Stop-hook nudge ([Hooks](PRD-hooks-v6.md) section 6) or written explicitly.
- **Proposed first.** They start as `proposed`, because they steer future behavior.
- **Retrieved by relevance.** Search finds them before similar work, and the brief lists the few most relevant active lessons by title.

Lessons are advisory: the current request, environment and verified results always win.

### 2.3 Brief contents

A brief draws only from the session's scope, the global `_me` and the profiles of the agent's pools that contain the scope ([Persona pools and access](PRD-pools-access-v3.md) section 6). Flagged and quarantined entries are never included; entries past their review-by date appear only if there is room, marked "review due" ([Context hygiene](PRD-context-hygiene-v2.md)).

Contents, in priority order:

1. A header with the scope, the time, the machine, the last sync and the session reference.
2. Notices: lost or taken-over claims, overlaps, drift, conflicts, the proposed count, and stale sync.
3. **Open signals:** unresolved blockers and incidents, blocking tasks and open flags, with their age ([Memory and journal](PRD-memory-journal-v2.md) section 4). Like the header and notices, these are never cut.
4. The latest status.
5. The latest handoff, one per client.
6. The pinned project brief.
7. Open claims, with holder, age, paths and overlaps, plus ready tasks.
8. Active conventions in the project.
9. Recent decisions, each with its reason.
10. **Memory:** preferences and conventions from the global `_me` and the matching pool profile (for example `_me.pool-notes`).
11. **Skill catalog:** the name and one-line description of each approved skill the session can use ([Skills](PRD-skills-v3.md)).
12. Relevant active lessons (titles only).
13. **Journal highlights:** milestones, breakthroughs and incidents from the last week.

Within a section, entries are ranked by **importance** ([Memory and journal](PRD-memory-journal-v2.md) section 5), so the most significant, connected, recent and used entries make the cut. Sections that do not fit end with the folder to browse for more, for example `ctxd://<scope>/decisions/`.

**Interrupted work.** When a session resumes or starts after compaction and the last checkpoint shows unfinished work, the brief says so plainly and tells the agent to verify which actions already completed before repeating anything. For example: "Your previous session was interrupted during 'sync apply.' Check the latest commits and working tree before redoing work; do not repeat side effects."

## 3. Search and fetch

- **Search covers the current project by default, or a folder.** With `path` (for example `ctxd://<scope>/lessons/`), search stays inside that folder ([Filesystem view](PRD-filesystem-view-v2.md)). It also searches the global `_me` and the matching pool profile. With `scope: "*"`, it searches every scope the agent can read through its pools; results from other projects are ranked lower and labeled with their scope.
- **Flags in search.** Flagged entries are labeled with the flag and reason and ranked lower; entries flagged `unsafe` and quarantined entries are not returned at all.
- **Search returns previews.** `context_search` gives each result's title, path, kind, status, author, date and a short snippet around the match, ranked by relevance and importance.
- **Time filters.** `since` and `until` (dates or ages such as `7d`) answer "what happened last week" in one call; with a `*` query they list entries by time.
- **Fetch is explicit.** `context_get` returns full entries by id, reference, path or `skill:<name>`, within a token budget. A folder path returns the folder's summaries and listing.
- **Proposed entries are labeled.** They are included by default but marked; superseded, archived and deleted entries are excluded unless asked for.
- **Semantic search comes later** (M5): a local embedding model blended with full-text ranking.

## 4. Size limits

- **SessionStart briefs are capped at about 9,500 characters**, under Claude Code's 10,000-character limit for inline hook context.
- **On resume or compaction,** the interrupted-work notice and latest handoff take priority within that cap.

## 5. Footprint

The seven MCP tools together must cost under about 1,500 tokens of tool definitions, so enabling ctxd does not eat the context it is meant to save. A test enforces this.

## 6. Agent ergonomics

Agents make small mistakes: a plural kind, a synonym for an enum value, a retry after a conflict. ctxd makes these cheap without growing the tool definitions:

- **Input aliases.** Common variants of enum values (for example `decisions`, `blocked`, `outdated`) are mapped to the canonical value before validation, and the response says what was mapped, so the agent learns. Aliases are not listed in tool definitions, so they cost nothing.
- **Errors that say what to do.** Every error carries its code, the field at fault, whether a retry can succeed, and a one-line hint (for example "Re-read the entry with context_get and retry with its current rev").
- **Response metering.** ctxd records the size of every response and injected brief locally, so `ctxd stats` shows which tools and briefs cost the most, without adding anything to responses.

## 7. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| BS-1 | Deterministic briefs at three sizes within budget, in the section order above | FR-5 | P0 |
| BS-2 | Notices section always present, including sync freshness and claim notices | FR-5 | P0 |
| BS-3 | Interrupted-work wording when the last checkpoint shows unfinished work | FR-5 | P1 |
| BS-4 | Full-text search with ranking by relevance, recency and kind; snippets around matches | FR-6 | P0 |
| BS-5 | Fetch by id within a token budget; truncation is explicit | FR-2 | P0 |
| BS-6 | Tool definitions under about 1,500 tokens in total, enforced by test | NFR-4 | P0 |
| BS-7 | Hybrid semantic search with a local embedding model | FR-20 | P2 |
| BS-8 | Every entry has a summary line (agent-written or first sentence); search and lists use it | FR-6 | P0 |
| BS-9 | `lesson` kind, proposed by default, surfaced by relevance in briefs and search | FR-29 | P1 |
| BS-10 | `_me` scope included in every brief; `scope: "*"` searches all readable scopes with a penalty for other projects | FR-9, FR-6 | P1 |
| BS-11 | SessionStart brief capped at about 9,500 characters | NFR-4 | P0 |
| BS-12 | Optional machine-written summaries from a local model, labeled as such | FR-20 | P3 |
| BS-13 | Briefs and search respect persona pools and session narrowing | FR-35 | P0 |
| BS-14 | Flagged, quarantined and unsafe entries handled as in sections 2.3 and 3 | FR-37, FR-38 | P0 |
| BS-15 | Open signals in every brief, never cut | FR-53 | P0 |
| BS-16 | Skill catalog within its own budget; approved skills only | FR-47 | P0 |
| BS-17 | Brief sections and search ranked with the importance score | FR-54 | P1 |
| BS-18 | Search `path`, `since` and `until`; results carry paths | FR-44, FR-52 | P1 |
| BS-19 | Input aliases and the error envelope with hints, at no token cost | FR-56 | P1 |
| BS-20 | Local response metering and `ctxd stats` | FR-56 | P2 |

## 8. Acceptance criteria

> Owner: A (agent-generated) by persona `product-writer`, derived from the requirements above; approved by the owner at Gate 1. Verification status per criterion: [test plan](../../test/test-plan-v1.md).

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| BS-AC-1 | Event-driven | When a session requests a `normal` brief for a scope that has a handoff and open claims, ctxd shall include the latest handoff and the open claims within the `normal` budget. | BS-1, CL-10 |
| BS-AC-2 | Event-driven | When a search query matches a decision's topic, ctxd shall return that decision among the top 3 results as a one-line preview. | BS-4, BS-8 |
| BS-AC-3 | Ubiquitous | The `tools/list` payload shall measure under about 1,500 tokens, checked in CI. | BS-6 |
| BS-AC-4 | State-driven | While a blocker signal is open in the session's working set, ctxd shall show it in `micro`, `normal` and `full` briefs. | BS-15 |
| BS-AC-5 | Ubiquitous | The SessionStart brief shall never exceed `session_start_max_chars`, and the header, notices and open signals shall survive the cut. | BS-11, BS-15, HK-16 |
| BS-AC-6 | Event-driven | When `context_search` receives `kinds: ["decisions"]`, ctxd shall coerce it to `decision`, succeed, and report the change in `coerced`. | BS-19 |

## 9. Open questions

| # | Question |
|---|---|
| BQ-1 | Embedding model choice (parent Q5) |
| BQ-2 | Whether to add a phrase-match option to search |
