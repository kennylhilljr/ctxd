# ctxd Component PRD: Knowledge Model (v3)

| | |
|---|---|
| **Status** | Draft v3 |
| **Date** | 2026-10-18 |
| **Supersedes** | [v2](PRD-knowledge-model-v2.md) |
| **Parent** | [ctxd PRD v6](../PRD-v6.md) |
| **Siblings** | [Persona pools and access](PRD-pools-access-v2.md), [Hooks and agent lifecycle](PRD-hooks-v5.md), [Claims and write intent](PRD-claims-v3.md), [Trust and safety](PRD-trust-safety-v4.md), [Context hygiene](PRD-context-hygiene-v1.md), [Replication](PRD-replication-v4.md), [Briefs and search](PRD-briefs-search-v4.md), [Filesystem view](PRD-filesystem-view-v1.md), [Skills](PRD-skills-v1.md), [Memory and journal](PRD-memory-journal-v1.md) |
| **Spec** | [Spec v6](../../spec/SPEC-v6.md) sections 4, 4.1 to 4.3, 6 and 8.2 (`context_write`, `context_get`, `context_flag`) |
| **Parent requirements elaborated** | FR-1, FR-3, FR-29 to FR-32, FR-46, FR-50, FR-51, FR-55 |
| **Adapted from** | [DataHub](https://github.com/datahub-project/datahub) (Apache-2.0): URNs, independently versioned aspects, change proposals versus change log with prior values, context documents with draft and published states, typed relationships. [OpenViking](https://github.com/volcengine/OpenViking): experience memory (lessons), personal versus project space, user memories and skills. [memory-journal-mcp](https://github.com/neverinfamous/memory-journal-mcp): journal entries with significance, causal links |

## Changes in v3

Earlier changes are listed in [v2](PRD-knowledge-model-v2.md).

| Change | Section |
|---|---|
| New kinds: `preference` (memory), `skill` (reusable procedures) and `journal` (time-ordered log with a significance) | 3, 3.2 |
| New relation types `caused` and `resolved` | 6 |
| Every entry has a stable path in the filesystem view ([Filesystem view](PRD-filesystem-view-v1.md)) | 5 |
| `_me` now holds memory and global skills | 2 |

## 1. Purpose

This component defines **what ctxd stores**:

- the kinds of entries;
- how an entry is split into independently versioned parts;
- how entries are identified and cited;
- how they relate to each other;
- how their history is kept.

The other components (hooks, claims, briefs, replication, trust) all build on it.

## 2. Scopes

A **scope** is a project or area, for example `ctxd`, `sample-app` or `notes`. Every entry belongs to one scope. Scope policies are defined in [Trust and safety](PRD-trust-safety-v4.md) and [Replication](PRD-replication-v4.md).

Scopes are granted to agents through **persona pools** ([Persona pools and access](PRD-pools-access-v2.md)). There are three kinds of reserved scope:

| Scope | Holds | Who reads it |
|---|---|---|
| `_me` (global) | Memory that applies everywhere: preferences, conventions, profile facts, lessons, and global skills ([Memory and journal](PRD-memory-journal-v1.md)) | Every agent, including unassigned ones; included in every brief |
| `_me.<pool>` (pool profile) | Persona-specific preferences, for example a preferred tone in `_me.pool-notes` | Members of that pool; included in their briefs when working in that pool |
| `_hold.<client>` (holding scope) | Writes from an agent that it was not allowed to place where it asked (for example, any write from an agent in no pool) | That agent and me only; never in other agents' briefs or searches |

Repositories are bound to scopes by their normalized `origin` URL ([Hooks](PRD-hooks-v5.md) section 2.1).

## 3. Entry kinds

| Kind | Meaning | Content after creation | Default status from an agent |
|---|---|---|---|
| `brief` | The pinned overview of a scope (one per scope) | Editable | `proposed` |
| `status` | Where work stands right now | Editable | `active` |
| `decision` | A choice that was made, with its reason | Immutable; replaced by a new decision that supersedes it | `proposed` |
| `convention` | A rule to follow | Editable | `proposed` |
| `fact` | Something learned that is not a decision | Editable | `proposed` |
| `lesson` | What went wrong or worked well on a kind of task, as advice for next time | Editable | `proposed` |
| `handoff` | What a session leaves for the next one | Immutable | `active` |
| `task` | A unit of work that can be claimed | Editable | `active` |
| `pointer` | A link to something outside ctxd (commit, file, URL) | Immutable | `active` |
| `note` | Anything else worth keeping | Editable | `active` |
| `preference` | How I like things done ([Memory and journal](PRD-memory-journal-v1.md)) | Editable | Always `proposed`; no review rule can auto-accept it |
| `skill` | A reusable procedure in `SKILL.md` form ([Skills](PRD-skills-v1.md)) | Editable, versioned | Always `proposed`, and invisible to other agents until approved |
| `journal` | A short, time-ordered record of something that happened, with a significance (3.2) | Immutable | `active`; `proposed` when its significance is `decision` |

Status values:

| Status | Meaning |
|---|---|
| `active` | Published |
| `proposed` | Draft awaiting my approval; visible to search but labeled, and excluded from briefs except as a count |
| `flagged` | Reported as wrong, stale, duplicate or unsafe; out of briefs until reviewed ([Context hygiene](PRD-context-hygiene-v1.md)) |
| `quarantined` | Part of a quarantine batch; out of briefs and search until reverted or released |
| `superseded` | Replaced by a newer entry |
| `archived` | Kept for history only |
| `conflicted` | Concurrent edits need a merge |
| `deleted` | Tombstone |

### 3.1 Review-by dates

Any entry may carry a review-by date. Defaults by kind:

| Kind | Review after |
|---|---|
| `status` | 14 days |
| `handoff` | 30 days |
| `fact` and `lesson` | 180 days |
| `preference` | 365 days |
| All other kinds, including `journal` and `skill` | Never, unless set |

Past the date, the entry is demoted in briefs and listed for review ([Context hygiene](PRD-context-hygiene-v1.md) section 7).

### 3.2 Journal significance

Every `journal` entry has a significance: `routine`, `milestone`, `breakthrough`, `blocker`, `incident` or `decision` (default `routine`). `blocker` and `incident` entries stay pinned in briefs as open signals until something resolves them ([Memory and journal](PRD-memory-journal-v1.md) section 4). Significance is not allowed on other kinds.

## 4. Parts of an entry, each versioned on its own

An entry is made of parts (DataHub calls them aspects), and each part has its own revision:

| Part | Holds | Who usually changes it |
|---|---|---|
| **Content** | Title, summary line, body, tags | The writing agent, or me when editing |
| **Status** | Status, plus who approved and when | Review (me), supersession |
| **Relations** | Typed links to other entries and to outside things | Agents and me |
| **Claim** (tasks only) | Holder, write intent, expiry | Agents claiming and releasing ([Claims](PRD-claims-v3.md)) |

**Why it matters:** when I approve a decision on one machine while an agent adds a relation to it on another, those changes touch different parts and never conflict. Optimistic concurrency checks only the revision of the part being changed.

## 5. References

Every entry has a stable, citable reference of the form `ctxd:<scope>/<id>`, for example `ctxd:ctxd/01JABCDEF...`. Agents use references in handoffs, decisions and commit messages ("implements `ctxd:ctxd/01JAB...`"). A reference stays valid across machines, renames and supersession: following a superseded reference shows the replacement.

Every entry also has a readable **path**, for example `ctxd://ctxd/decisions/use-an-event-log-7k2pqz.md`, fixed when it is created ([Filesystem view](PRD-filesystem-view-v1.md)). Paths and references are interchangeable wherever an entry is named, and a skill can also be named as `skill:<name>`.

## 6. Relationships

Relations are typed, directed links:

| Type | Meaning | Example |
|---|---|---|
| `supersedes` | This entry replaces that one | Decision B supersedes decision A |
| `implements` | This work carries out that decision or convention | Task implements decision |
| `derived_from` | This was learned from that | Lesson derived from handoff |
| `blocks` | This must finish before that | Task blocks task |
| `relates_to` | General association | Fact relates to convention |
| `points_to` | Outside reference (file, commit, URL) | Pointer to a commit |
| `caused` | This led to that problem | A change caused an incident |
| `resolved` | This fixed that blocker, incident or task | A commit's journal entry resolved a blocker |

Relationships make chains visible:

- **Following chains.** `context_get` can include an entry's directly related entries (one hop), so an agent can follow a decision's history without extra searches.
- **Stale implementations.** When a decision is superseded, active tasks that `implement` it get a notice in the next brief ("the decision this task implements was replaced").

## 7. History and audit

- **Every change is kept.** Each applied change records which part changed, the new value, the previous value, the author, the session and the machine. Diffs in review and "what did this say last week?" are therefore always answerable.
- **Rejected writes are recorded too, as metadata only.** That covers which client, which entry, which error and when; content is never stored, so a rejected secret is never kept. This shows when agents keep colliding or keep tripping redaction.
- **Purge is the one exception.** Purging an entry erases its content from the entry and from every recorded change, leaving an audited stub: reference, kind, purge time, reason, who purged it, and a fingerprint of the removed text ([Context hygiene](PRD-context-hygiene-v1.md) section 6).
- **Point-in-time reads.** `ctxd history <reference>` shows an entry's full history; `ctxd show <reference> --at <time>` shows it as it was.

## 8. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| KM-1 | Entry kinds and default statuses as in section 3 | FR-1 | P0 |
| KM-2 | Content, status, relations and claim parts versioned independently; concurrency checks apply per part | FR-3 | P0 |
| KM-3 | Stable references `ctxd:<scope>/<id>`; superseded references resolve to their replacement | FR-30 | P1 |
| KM-4 | Typed relations as in section 6; one-hop related entries available from `context_get` | FR-31 | P1 |
| KM-5 | Notice when a task's implemented decision is superseded | FR-31 | P2 |
| KM-6 | Every applied change records the previous value of the changed part | FR-32 | P0 |
| KM-7 | Rejected writes recorded as metadata only (never content) | FR-32 | P1 |
| KM-8 | `ctxd history` and point-in-time `ctxd show --at` | FR-32 | P2 |
| KM-9 | `lesson` kind | FR-29 | P1 |
| KM-10 | Reserved scopes `_me`, `_me.<pool>` and `_hold.<client>` | FR-34 | P0 |
| KM-11 | Statuses `flagged` and `quarantined`; purge stubs | FR-37, FR-38, FR-40 | P0 |
| KM-12 | Review-by dates with per-kind defaults | FR-41 | P1 |
| KM-13 | `preference` kind, always proposed when written by an agent | FR-50 | P0 |
| KM-14 | `skill` kind with a validated `SKILL.md` body | FR-46 | P0 |
| KM-15 | `journal` kind: immutable, with significance | FR-51 | P0 |
| KM-16 | `caused` and `resolved` relations | FR-55 | P1 |
| KM-17 | Stable paths, interchangeable with references | FR-43 | P0 |

## 9. Acceptance criteria

- Approving a decision on the Air while an agent on the laptop adds a relation to it produces no conflict after sync.
- A commit message citing an entry reference resolves to that entry, or to its replacement if superseded.
- For any entry, `ctxd history` shows every change with its author, machine and prior value.
- A write rejected for containing a secret leaves a rejection record with no part of the secret in it.
- A `journal` entry cannot be edited, and `significance` on any other kind is refused.
- Renaming an entry's title never changes its path.

## 10. Open questions

| # | Question |
|---|---|
| KQ-1 | Should relations also cross scopes (for example a work-style convention in `_me` that a project implements)? Proposed: yes, read-only references across scopes the client can read |
| KQ-2 | Retention for history: keep everything, or compact superseded content older than a year (Replication RQ-2) |
