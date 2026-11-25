# ctxd Component PRD: Filesystem View (v3)

| | |
|---|---|
| **Status** | Draft v3 |
| **Date** | 2026-11-25 |
| **Supersedes** | [v2](PRD-filesystem-view-v2.md) |
| **Parent** | [ctxd PRD v8](../PRD-v8.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v4.md), [Skills](PRD-skills-v3.md), [Memory and journal](PRD-memory-journal-v2.md), [Persona pools and access](PRD-pools-access-v4.md), [Hooks and agent lifecycle](PRD-hooks-v6.md), [Claims and write intent](PRD-claims-v4.md), [Trust and safety](PRD-trust-safety-v5.md), [Context hygiene](PRD-context-hygiene-v2.md), [Replication](PRD-replication-v7.md), [Briefs and search](PRD-briefs-search-v5.md) |
| **Spec** | [Spec v10](../../spec/SPEC-v10.md) (HLD) sections 4.2, 8.2 (`path`), 12.1 and 13; detail in [LLD: Data model](../../lld/LLD-data-model-v1.md), [LLD: Operations](../../lld/LLD-operations-v2.md) |
| **Acceptance tests** | [Test plan v1](../../test/test-plan-v1.md), FS section |
| **Parent requirements elaborated** | FR-19, FR-43 to FR-45; NFR-1 |
| **Adapted from** | [OpenViking](https://github.com/volcengine/OpenViking) `viking://` filesystem and L0/L1/L2 directory tiers; [memory-journal-mcp](https://github.com/neverinfamous/memory-journal-mcp) Markdown round trip |

## Changes in v3

Earlier changes are listed in [v2](PRD-filesystem-view-v2.md) and before.

- **Name validation and mirror containment.** New requirements FS-9 and FS-10, stated by the owner in [issue 77](https://github.com/kennylhilljr/ctxd/issues/77), and criteria FS-AC-6 to FS-AC-11, derived from them, [LLD: Data model](../../lld/LLD-data-model-v1.md) section 4 and [LLD: Operations](../../lld/LLD-operations-v2.md) 12.1. The 5 earlier criteria are unchanged; there are now 11.
- **Links.** The header names NFR-1, which FS-9 and FS-10 also trace to; sibling links point to current versions.

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
| FS-9 | Names that become path segments (scope names, entry slugs, skill names) are validated whenever an event materializes, written locally or received from a peer; an invalid one is rejected and its event is not stored | FR-43, NFR-1 | P0 |
| FS-10 | Every mirror write, rename and unlink, and every file `ctxd export` writes, stays inside its root directory and never passes through a symbolic link below it | FR-45, NFR-1 | P0 |

## 7. Acceptance criteria

> Owner: A (agent-generated) by persona `product-writer`, derived from the requirements above; pending the owner's approval at Gate 1. Verification status per criterion: [test plan](../../test/test-plan-v1.md). FS-9 and FS-10 were stated by the owner in [issue 77](https://github.com/kennylhilljr/ctxd/issues/77); FS-AC-6 to FS-AC-11 derive from them and [LLD: Data model](../../lld/LLD-data-model-v1.md) section 4 and [LLD: Operations](../../lld/LLD-operations-v2.md) 12.1.

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| FS-AC-1 | Event-driven | When the human runs `ctxd tree ctxd://_me -L 2`, ctxd shall show the preference, convention, lesson, skill and journal folders with their one-line summaries. | FS-1, FS-2, FS-5 |
| FS-AC-2 | Event-driven | When an agent lists `ctxd://`, ctxd shall show only the scopes its persona can read, plus `_me`. | FS-3 |
| FS-AC-3 | Event-driven | When the human edits an entry's status in the mirror, ctxd shall record the change as a human-client event. | FS-6 |
| FS-AC-4 | Unwanted behavior | If a mirror edit is based on a stale revision, then ctxd shall write a `.conflict.md` file and a review item and apply nothing. | FS-6 |
| FS-AC-5 | Event-driven | When `context_search` is given `path: "ctxd://<project>/lessons/"`, ctxd shall return only that project's lessons. | FS-4 |
| FS-AC-6 | Unwanted behavior | If a `scope_create` event, written locally or received from a peer, carries a name outside the scope grammar, then ctxd shall reject it and store neither the scope nor the event. | FS-9 |
| FS-AC-7 | Unwanted behavior | If an entry create, written locally or received from a peer, carries a slug outside the slug grammar or longer than 64 characters, then ctxd shall reject it and store neither the entry nor the event. | FS-9 |
| FS-AC-8 | Unwanted behavior | If a skill create, written locally or received from a peer, carries no skill name, one outside the skill-name grammar or one longer than 64 characters, then ctxd shall reject it and store neither the entry nor the event. | FS-9 |
| FS-AC-9 | Unwanted behavior | If a mirror write, rename or unlink resolves to a path outside the mirror root, then ctxd shall refuse it and leave the outside path untouched. | FS-10 |
| FS-AC-10 | Unwanted behavior | If a mirror write, rename or unlink would pass through a symbolic link below the mirror root, then ctxd shall refuse it and leave the link's target untouched. | FS-10 |
| FS-AC-11 | Unwanted behavior | If a file `ctxd export` writes resolves outside the output directory or passes through a symbolic link below it, then ctxd shall refuse the export and write nothing outside the output directory. | FS-10 |

## 8. Open questions

| # | Question |
|---|---|
| FQ-1 | Should the mirror be one tree, or one tree per persona so I can see exactly what each persona sees? |
| FQ-2 | Obsidian specifics: wiki links by reference or by path? |
