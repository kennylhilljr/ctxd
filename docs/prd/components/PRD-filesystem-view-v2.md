# ctxd Component PRD: Filesystem View (v2)

| | |
|---|---|
| **Status** | Draft v2 |
| **Date** | 2026-10-20 |
| **Supersedes** | [v1](PRD-filesystem-view-v1.md) |
| **Parent** | [ctxd PRD v8](../PRD-v8.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v4.md), [Skills](PRD-skills-v3.md), [Memory and journal](PRD-memory-journal-v2.md), [Persona pools and access](PRD-pools-access-v3.md), [Hooks and agent lifecycle](PRD-hooks-v6.md), [Claims and write intent](PRD-claims-v4.md), [Trust and safety](PRD-trust-safety-v5.md), [Context hygiene](PRD-context-hygiene-v2.md), [Replication](PRD-replication-v6.md), [Briefs and search](PRD-briefs-search-v5.md) |
| **Spec** | [Spec v10](../../spec/SPEC-v10.md) (HLD) sections 4.2, 8.2 (`path`), 12.1 and 13; detail in [LLD: Data model](../../lld/LLD-data-model-v1.md), [LLD: Operations](../../lld/LLD-operations-v1.md) |
| **Acceptance tests** | [Test plan v1](../../test/test-plan-v1.md), FS section |
| **Parent requirements elaborated** | FR-19, FR-43 to FR-45 |
| **Adapted from** | [OpenViking](https://github.com/volcengine/OpenViking) `viking://` filesystem and L0/L1/L2 directory tiers; [memory-journal-mcp](https://github.com/neverinfamous/memory-journal-mcp) Markdown round trip |

## Changes in v2

Earlier changes are listed in [v1](PRD-filesystem-view-v1.md) and before.

- **Acceptance criteria in EARS, with IDs.** Every criterion is now one EARS statement with an ID (`FS-AC-n`) and the component requirements it verifies. The 4 criteria became 5: compound criteria were split so each states one response, and behavior the spec's test table already assumed was made explicit. Each ID is mapped to its tests, or marked as a gap, in the [test plan](../../test/test-plan-v1.md).
- **Links.** The header points to PRD v8, Spec v10 (now the system HLD) and this component's LLD; sibling links point to current versions.

## 1. Purpose

A context store is only trusted if you can see what is in it. Typed entries and MCP tools are right for agents, but people think in folders and files. This component adds a **filesystem view**: every entry gets a readable path, folders carry summaries, and I can browse, search and edit ctxd like a folder of Markdown files.

**The view is a projection.** The typed store stays the source of truth, because it is what provides provenance, safe concurrent writes, per-persona access, review, cleanup and multi-machine sync. Paths are computed from it. Edits made through the view become ordinary recorded changes.

## 2. Path layout

```
ctxd://
├── _me/                         global profile (every agent reads it)
│   ├── .abstract                one line: what this space holds
│   ├── .overview                the brief tier for this space
│   ├── preferences/             how I like things done
│   ├── conventions/             rules to follow everywhere
│   ├── profile/                 facts about me I chose to record
│   ├── lessons/                 experience from past work
│   ├── skills/<name>/SKILL.md   skills available to every agent
│   └── journal/2026/10/18.md    day view of journal entries
├── _me.<pool>/                  pool profile (same layout)
├── <project>/
│   ├── .abstract  .overview     project one-liner and overview
│   ├── brief.md                 the pinned project brief
│   ├── status/  decisions/  conventions/  facts/  lessons/
│   ├── handoffs/  tasks/  pointers/  notes/
│   ├── skills/<name>/SKILL.md   project skills
│   └── journal/2026/10/18.md
└── _hold.<agent>/               holding scope (only that agent and I see it)
```

- **Entry files.** Each entry is `<kind folder>/<slug>.md`. The slug is derived from the title when the entry is created, with the last six characters of its id appended, and it never changes, so paths stay stable. A renamed entry keeps its path.
- **Folder summaries.** Every folder has a one-line `.abstract` and an `.overview`, generated without a model:
  - **Scope folders:** the scope's summary line and pinned brief.
  - **Kind folders:** a count and the summary lines of their most important entries.
  - **Journal day files:** that day's entries in time order.
- **Persona-filtered tree.** Agents see only what their session's persona can read. Scopes outside it do not appear at all, not even as folder names.
- **Paths and references are interchangeable.** `ctxd://<project>/decisions/use-an-event-log-7k2pqz.md` and `ctxd:<project>/<id>` resolve to the same entry.

## 3. For agents

No new MCP tools are added:

- **`context_get`** accepts paths as well as references and ids. Asking for a folder returns its `.abstract`, its `.overview` and a listing of summaries.
- **`context_search`** takes an optional `path` to search within one folder or subtree, for example `ctxd://<project>/decisions/` or `ctxd://_me/lessons/`.
- **Search results** show each entry's path next to its reference, and brief sections that run out of room point to the folder to browse, so agents can navigate as well as search.

## 4. For me: the CLI

| Command | Does |
|---|---|
| `ctxd ls <path>` | List a folder with summary lines |
| `ctxd tree <path> [-L n]` | Show the tree to a depth |
| `ctxd read <path>` | Print an entry, or a folder's overview |
| `ctxd grep <pattern> [<path>]` | Search text within a subtree |
| `ctxd open <path>` | Open the entry's mirror file in my editor |

## 5. The editable mirror

`ctxd mirror` keeps a folder of Markdown files on my Mac, in ctxd's data folder (never in a repository), that matches the tree. I can browse it in Finder, an editor or Obsidian, and edit it.

- **Format.** Each file has YAML frontmatter: reference, kind, status, revision, author, updated time, relations as `[[wiki links]]` and review-by date. The body follows.
- **Edits flow back.** A watcher turns saved edits into updates from the human client:
  - **Concurrency.** The revision in the frontmatter is checked first. A conflicting edit leaves a `.conflict` copy next to the file and an item in review.
  - **New files.** A file with frontmatter creates a new entry.
  - **Deleted files.** These become archive requests that I confirm in review, never silent deletes.
  - **The normal path.** Sanitization, history and sync apply as for any other change.
- **Whose view it is.** The mirror is mine, written as the human client and showing everything I can see. Agents never use it: the path guard blocks agents from the mirror folder, and they use the MCP tools instead.
- **Sealed pools are never mirrored**, because a plaintext copy would defeat their encryption.
- **Import.** `ctxd import <folder>` brings in a folder of Markdown files with frontmatter, for example from another tool's export, as proposed entries for review.

## 6. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| FS-1 | Every entry and folder has a stable `ctxd://` path; paths and references resolve to the same entry | FR-43 | P0 |
| FS-2 | Generated `.abstract` and `.overview` for every scope and kind folder, without a model | FR-43 | P1 |
| FS-3 | The tree is filtered by the session's persona; unreadable scopes are invisible | FR-43 | P0 |
| FS-4 | `context_get` accepts paths and folders; `context_search` accepts a `path` prefix; no new tools | FR-44 | P0 |
| FS-5 | CLI `ls`, `tree`, `read`, `grep`, `open` | FR-44 | P1 |
| FS-6 | Two-way Markdown mirror with frontmatter; edits become human-client changes with revision checks; deletes become archive requests | FR-45 | P2 |
| FS-7 | Sealed pools never mirrored; mirror folder covered by the path guard | FR-45 | P0 |
| FS-8 | `ctxd import` of Markdown folders as proposed entries | FR-19 | P2 |

## 7. Acceptance criteria

> Owner: A (agent-generated) by persona `product-writer`, derived from the requirements above; pending the owner's approval at Gate 1. Verification status per criterion: [test plan](../../test/test-plan-v1.md).

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| FS-AC-1 | Event-driven | When the human runs `ctxd tree ctxd://_me -L 2`, ctxd shall show the preference, convention, lesson, skill and journal folders with their one-line summaries. | FS-1, FS-2, FS-5 |
| FS-AC-2 | Event-driven | When an agent lists `ctxd://`, ctxd shall show only the scopes its persona can read, plus `_me`. | FS-3 |
| FS-AC-3 | Event-driven | When the human edits an entry's status in the mirror, ctxd shall record the change as a human-client event. | FS-6 |
| FS-AC-4 | Unwanted behavior | If a mirror edit is based on a stale revision, then ctxd shall write a `.conflict.md` file and a review item and apply nothing. | FS-6 |
| FS-AC-5 | Event-driven | When `context_search` is given `path: "ctxd://<project>/lessons/"`, ctxd shall return only that project's lessons. | FS-4 |

## 8. Open questions

| # | Question |
|---|---|
| FQ-1 | Should the mirror be one tree, or one tree per persona so I can see exactly what each persona sees? |
| FQ-2 | Obsidian specifics: wiki links by reference or by path? |
