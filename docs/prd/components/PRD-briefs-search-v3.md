# ctxd Component PRD: Briefs and Search (v3)

| | |
|---|---|
| **Status** | Draft v3 |
| **Date** | 2026-10-18 |
| **Supersedes** | [v2](PRD-briefs-search-v2.md) |
| **Parent** | [ctxd PRD v4](../PRD-v4.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v2.md), [Persona pools and access](PRD-pools-access-v1.md), [Hooks and agent lifecycle](PRD-hooks-v3.md), [Claims and write intent](PRD-claims-v3.md), [Trust and safety](PRD-trust-safety-v3.md), [Context hygiene](PRD-context-hygiene-v1.md), [Replication](PRD-replication-v3.md) |
| **Spec** | [Spec v4](../../spec/SPEC-v4.md) sections 4, 8.2 and 11 |
| **Parent requirements elaborated** | FR-2, FR-5, FR-6, FR-20; NFR-4 |
| **Adapted from** | codex-agent-mem budgeted packs; claude-mem progressive disclosure; [OpenWork](https://github.com/different-ai/openwork) search-then-read and recovery wording; [OpenViking](https://github.com/volcengine/OpenViking) L0/L1/L2 context tiers, experience memory and cross-project recall with a penalty |

## Changes in v3

Earlier changes are listed in [v2](PRD-briefs-search-v3.md).

| Change | Section |
|---|---|
| Briefs are narrowed to the session's persona: project scope, global `_me`, and matching pool profiles | 2.3 |
| Flagged and quarantined entries never appear in briefs; entries past their review-by date are demoted | 2.3 |
| Search covers only scopes the agent can read through its pools; flagged entries are labeled and ranked lower; `unsafe` flags are hidden | 3 |

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

Agents may write the summary line themselves; otherwise ctxd takes the first sentence of the body. No model is required. With the Mac Studio's local model (M6), ctxd can optionally improve summaries and scope overviews, marked as machine-written.

### 2.2 Lessons

A `lesson` records what went wrong or worked unusually well on a kind of task, for example: "Running the sync property tests with fewer than 500 runs missed the tombstone bug; use 2,000." Lessons are:

- **Captured** through the Stop-hook nudge ([Hooks](PRD-hooks-v3.md) section 6) or written explicitly.
- **Proposed first.** They start as `proposed`, because they steer future behavior.
- **Retrieved by relevance.** Search finds them before similar work, and the brief lists the few most relevant active lessons by title.

Lessons are advisory: the current request, environment and verified results always win.

### 2.3 Brief contents

A brief draws only from the session's scope, the global `_me` and the profiles of the agent's pools that contain the scope ([Persona pools and access](PRD-pools-access-v1.md) section 6). Flagged and quarantined entries are never included; entries past their review-by date appear only if there is room, marked "review due" ([Context hygiene](PRD-context-hygiene-v1.md)).

Contents, in priority order:

1. A header with the scope, the time, the machine, the last sync and the session reference.
2. Notices: lost or taken-over claims, overlaps, drift, conflicts, the proposed count, and stale sync.
3. The latest status.
4. The latest handoff, one per client.
5. The pinned project brief.
6. Open claims, with holder, age, paths and overlaps, plus ready tasks.
7. Active conventions, including global `_me` conventions and the matching pool profile (for example `_me.pool-notes`).
8. Recent decisions, each with its reason.
9. Relevant active lessons (titles only).

Sections that do not fit end with a pointer to search for more.

**Interrupted work.** When a session resumes or starts after compaction and the last checkpoint shows unfinished work, the brief says so plainly and tells the agent to verify which actions already completed before repeating anything. For example: "Your previous session was interrupted during 'sync apply.' Check the latest commits and working tree before redoing work; do not repeat side effects."

## 3. Search and fetch

- **Search covers the current project by default.** It also searches the global `_me` and the matching pool profile. With `scope: "*"`, it searches every scope the agent can read through its pools; results from other projects are ranked lower and labeled with their scope.
- **Flags in search.** Flagged entries are labeled with the flag and reason and ranked lower; entries flagged `unsafe` and quarantined entries are not returned at all.
- **Search returns previews.** `context_search` gives each result's title, kind, status, author, date and a short snippet around the match, ranked by relevance, recency and kind.
- **Fetch is explicit.** `context_get` returns full entries by id, within a token budget.
- **Proposed entries are labeled.** They are included by default but marked; superseded, archived and deleted entries are excluded unless asked for.
- **Semantic search comes later** (M5): a local embedding model blended with full-text ranking.

## 4. Size limits

- **SessionStart briefs are capped at about 9,500 characters**, under Claude Code's 10,000-character limit for inline hook context.
- **On resume or compaction,** the interrupted-work notice and latest handoff take priority within that cap.

## 5. Footprint

The six MCP tools together must cost under about 1,500 tokens of tool definitions, so enabling ctxd does not eat the context it is meant to save. A test enforces this.

## 6. Component requirements

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

## 7. Acceptance criteria

- A `normal` brief for an active project stays within budget and includes the latest handoff and open claims.
- A search for a decision's topic returns that decision in the top 3, as a preview.
- Tool definitions measure under the budget in CI.

## 8. Open questions

| # | Question |
|---|---|
| BQ-1 | Embedding model choice (parent Q5) |
| BQ-2 | Whether to add a phrase-match option to search |
