# ctxd Component PRD: Memory and Journal (v2)

| | |
|---|---|
| **Status** | Draft v2 |
| **Date** | 2026-10-20 |
| **Supersedes** | [v1](PRD-memory-journal-v1.md) |
| **Parent** | [ctxd PRD v8](../PRD-v8.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v4.md), [Filesystem view](PRD-filesystem-view-v2.md), [Skills](PRD-skills-v3.md), [Persona pools and access](PRD-pools-access-v3.md), [Hooks and agent lifecycle](PRD-hooks-v6.md), [Claims and write intent](PRD-claims-v4.md), [Trust and safety](PRD-trust-safety-v5.md), [Context hygiene](PRD-context-hygiene-v2.md), [Replication](PRD-replication-v6.md), [Briefs and search](PRD-briefs-search-v5.md) |
| **Spec** | [Spec v10](../../spec/SPEC-v10.md) (HLD) sections 4.1, 4.3, 6, 9.2, 9.3 and 11.1 to 11.5; detail in [LLD: Briefs and search](../../lld/LLD-briefs-search-v1.md), [LLD: Data model](../../lld/LLD-data-model-v1.md) |
| **Acceptance tests** | [Test plan v1](../../test/test-plan-v1.md), MJ section |
| **Parent requirements elaborated** | FR-50 to FR-55 |
| **Adapted from** | [OpenViking](https://github.com/volcengine/OpenViking) user memories (preferences, experiences); [memory-journal-mcp](https://github.com/neverinfamous/memory-journal-mcp) project journal, significance, importance score, causal links, pinned signals and weekly digests |

## Changes in v2

Earlier changes are listed in [v1](PRD-memory-journal-v1.md) and before.

- **Acceptance criteria in EARS, with IDs.** Every criterion is now one EARS statement with an ID (`MJ-AC-n`) and the component requirements it verifies. The 4 criteria became 5: compound criteria were split so each states one response, and behavior the spec's test table already assumed was made explicit. Each ID is mapped to its tests, or marked as a gap, in the [test plan](../../test/test-plan-v1.md).
- **Links.** The header points to PRD v8, Spec v10 (now the system HLD) and this component's LLD; sibling links point to current versions.

## 1. Purpose

Two kinds of continuity matter beyond project decisions:

- **Memory:** what agents should know about *me* and how I work, everywhere. That includes preferences, standing rules, a few facts I choose to record, and experience from past work.
- **Journal:** what *happened*, in order. Agents need a running log of work and events to answer "what did we do last week?", "when did this break?" and "what is still blocking?", without rereading every handoff.

## 2. Memory

Memory lives in the global `_me` scope and the per-pool profiles (`_me.<pool>`). It is organized by kind:

| Kind | Holds | Example |
|---|---|---|
| `preference` (new) | How I like things done | "Prefers numbered versions of documents for each round of edits" |
| `convention` | Rules to follow everywhere | "No em dashes in prose" |
| `fact` | Facts about me or my setup I chose to record | "Uses a MacBook Air as the always-on hub" |
| `lesson` | Experience from past work | "Run property tests with 2,000 cases; 500 missed a bug" |

**How memory is written:**

- **Explicitly.** I say "remember that..." in any session; the agent records it as a `proposed` preference, convention or fact in `_me` (or the session's pool profile when it is persona-specific). `ctxd remember "<text>"` does the same from the terminal, as `active`.
- **Through the nudge.** The Stop-hook handoff nudge also asks whether the session revealed a lasting preference worth proposing.
- **Never silently.** Agent-written memory is always `proposed`. Optional extraction by a local model (M6) also only proposes.

**What memory never holds.** Sanitization rejects secrets. Memory also never holds sensitive personal data unless I write it myself, and even then not in scopes that cloud agents can read; that belongs in a sealed pool.

**How memory is used:**

- **Briefs.** Every brief includes the most important preferences and conventions within its `_me` budget ([Briefs and search](PRD-briefs-search-v5.md)).
- **Search** covers memory like any scope.

## 3. Journal

The journal is an append-only, time-ordered log, one per scope (projects, `_me` and pool profiles).

- **Entries.** Kind `journal`: short (up to about 1,000 characters), immutable, with a time, an author, and a **significance**:

  | Significance | Use |
  |---|---|
  | `routine` | Ordinary progress |
  | `milestone` | Something shipped or finished |
  | `breakthrough` | A problem cracked or an insight |
  | `blocker` | Something stopping progress |
  | `incident` | Something broke |
  | `decision` | A decision was made (links to the decision entry) |

- **Written automatically.** The hooks that already record sessions and commits now write journal entries instead of bare pointers:
  - a session-end summary, including the handoff's one-line summary;
  - one entry per commit, with its subject.
- **Written by agents.** Agents add entries for notable events ("tests green after tombstone fix," "blocked on missing credentials"), as `active`, except entries with significance `decision`, which are `proposed`.
- **Written by me.** `ctxd log "<text>" [--significance milestone]`.
- **Day view.** The filesystem view shows `journal/<year>/<month>/<day>.md` per scope ([Filesystem view](PRD-filesystem-view-v2.md)).
- **Weekly digest.** Every Sunday, ctxd writes one digest entry per active scope. It is assembled without a model: counts, milestones, blockers opened and resolved, decisions made, and lessons added. An optional local-model summary can come later (M6).
- **Time queries.** Search can filter by time (`since`, `until`), so "what happened last week in this project" is one call.

## 4. Open signals

Some items must stay in front of every agent until they are resolved. **Open signals** are pinned at the top of every brief in the scope until resolved:

- journal entries with significance `blocker` or `incident`;
- tasks that block other tasks;
- open flags.

- **Resolution.** An approved entry with a `resolved` link to a blocker, incident or blocking task closes it; a flag closes when I resolve it. A proposed entry's link counts only once I approve it. The time to resolve is recorded, so the weekly digest can show how long blockers lasted.
- **Persona.** Signals follow the session's persona like everything else.

## 5. Importance

Briefs have fixed budgets, so ctxd needs a fair way to decide what makes the cut. Every entry gets a transparent **importance score** from:

- **Significance or kind weight:** decisions, conventions, blockers and milestones score higher.
- **Links:** how many entries relate to it, with causal links (`caused`, `resolved`, `blocks`) counting more.
- **Recency:** a 90-day decay.
- **Use:** how often it was read or included in briefs (local counts).

**Where it is used:**

- **Ranking** within brief sections and search ties.
- **`ctxd tidy` suggestions** (low importance, old, unread).
- **Never on its own.** The score never archives or deletes anything.

`ctxd show <ref> --why` prints the score and its parts.

## 6. Causal links

Two new relation types join `blocks`:

- `caused`: this event or change caused that problem.
- `resolved`: this change resolved that blocker, incident or flag.

Together they let a brief or the journal trace a problem from cause to fix.

## 7. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| MJ-1 | `preference` kind; memory organized in `_me` and pool profiles as in section 2 | FR-50 | P0 |
| MJ-2 | "Remember that..." from any session proposes memory; `ctxd remember` writes it directly | FR-50 | P0 |
| MJ-3 | Agent-written memory is always `proposed` | FR-50 | P0 |
| MJ-4 | `journal` kind: append-only, short, with significance; written by hooks, agents and me | FR-51 | P0 |
| MJ-5 | Hooks write session-end and commit journal entries | FR-51 | P0 |
| MJ-6 | Weekly digest per active scope, assembled without a model | FR-52 | P1 |
| MJ-7 | Time filters (`since`, `until`) in search | FR-52 | P1 |
| MJ-8 | Open signals pinned at the top of briefs until resolved; time to resolve recorded | FR-53 | P0 |
| MJ-9 | Importance score with a visible breakdown; ranking and tidy only, never deletion | FR-54 | P1 |
| MJ-10 | `caused` and `resolved` relation types | FR-55 | P1 |

## 8. Acceptance criteria

> Owner: A (agent-generated) by persona `product-writer`, derived from the requirements above; pending the owner's approval at Gate 1. Verification status per criterion: [test plan](../../test/test-plan-v1.md).

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| MJ-AC-1 | Event-driven | When the user asks any agent to remember a lasting preference, ctxd shall create a `proposed` preference in `_me` that appears in every client's brief once approved. | MJ-1, MJ-2, MJ-3 |
| MJ-AC-2 | Event-driven | When the human reads a day's journal file, ctxd shall show that day's session summaries and commits in time order. | MJ-4, MJ-5 |
| MJ-AC-3 | State-driven | While a `blocker` journal entry is unresolved, every brief for its scope shall list it in the open-signals section. | MJ-8 |
| MJ-AC-4 | Event-driven | When a `resolved` link closes a blocker, the weekly digest shall report how long it stayed open. | MJ-6, MJ-8 |
| MJ-AC-5 | Event-driven | When the human runs `ctxd show <ref> --why`, ctxd shall print the importance score and the four parts that produced it. | MJ-9 |

## 9. Open questions

| # | Question |
|---|---|
| MQ-1 | Should the weekly digest be delivered somewhere (for example a notification), or just stored? |
| MQ-2 | Journal retention: keep forever, or roll routine entries older than a year into monthly digests? |
