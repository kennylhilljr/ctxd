# ctxd Component PRD: Memory and Journal (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-18 |
| **Parent** | [ctxd PRD v6](../PRD-v6.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v3.md), [Filesystem view](PRD-filesystem-view-v1.md), [Skills](PRD-skills-v1.md), [Persona pools and access](PRD-pools-access-v2.md), [Hooks and agent lifecycle](PRD-hooks-v5.md), [Claims and write intent](PRD-claims-v3.md), [Trust and safety](PRD-trust-safety-v4.md), [Context hygiene](PRD-context-hygiene-v1.md), [Replication](PRD-replication-v4.md), [Briefs and search](PRD-briefs-search-v4.md) |
| **Spec** | [Spec v6](../../spec/SPEC-v6.md) sections 4.1, 4.3, 6, 9.2, 9.3, 11.1 to 11.5 and 13 (`remember`, `log`, `journal`, `digest`, `signals`, `show --why`) |
| **Parent requirements elaborated** | FR-50 to FR-55 |
| **Adapted from** | [OpenViking](https://github.com/volcengine/OpenViking) user memories (preferences, experiences); [memory-journal-mcp](https://github.com/neverinfamous/memory-journal-mcp) project journal, significance, importance score, causal links, pinned signals and weekly digests |

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

- **Briefs.** Every brief includes the most important preferences and conventions within its `_me` budget ([Briefs and search](PRD-briefs-search-v4.md)).
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
- **Day view.** The filesystem view shows `journal/<year>/<month>/<day>.md` per scope ([Filesystem view](PRD-filesystem-view-v1.md)).
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

- Saying "remember that I want numbered document versions" in a Codex session creates a proposed preference in `_me` that appears in Claude Code's next brief once approved.
- After a day of work, `ctxd read ctxd://<project>/journal/2026/10/18.md` shows session summaries and commits in order.
- A `blocker` journal entry appears at the top of every brief in that project until an entry `resolved` it, and the digest reports how long it stayed open.
- `ctxd show <ref> --why` explains why an entry made it into a brief.

## 9. Open questions

| # | Question |
|---|---|
| MQ-1 | Should the weekly digest be delivered somewhere (for example a notification), or just stored? |
| MQ-2 | Journal retention: keep forever, or roll routine entries older than a year into monthly digests? |
