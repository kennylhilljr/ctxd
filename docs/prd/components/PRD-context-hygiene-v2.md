# ctxd Component PRD: Context Hygiene (v2)

| | |
|---|---|
| **Status** | Draft v2 |
| **Date** | 2026-10-20 |
| **Supersedes** | [v1](PRD-context-hygiene-v1.md) |
| **Parent** | [ctxd PRD v8](../PRD-v8.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v4.md), [Persona pools and access](PRD-pools-access-v3.md), [Hooks and agent lifecycle](PRD-hooks-v6.md), [Claims and write intent](PRD-claims-v4.md), [Trust and safety](PRD-trust-safety-v5.md), [Replication](PRD-replication-v6.md), [Briefs and search](PRD-briefs-search-v5.md) |
| **Spec** | [Spec v10](../../spec/SPEC-v10.md) (HLD) sections 4, 7.6, 8.2 (`context_flag`), 11 and 13; detail in [LLD: Context hygiene](../../lld/LLD-context-hygiene-v1.md) |
| **Acceptance tests** | [Test plan v1](../../test/test-plan-v1.md), CH section |
| **Parent requirements elaborated** | FR-37 to FR-41 |

## Changes in v2

Earlier changes are listed in [v1](PRD-context-hygiene-v1.md) and before.

- **Acceptance criteria in EARS, with IDs.** Every criterion is now one EARS statement with an ID (`CH-AC-n`) and the component requirements it verifies. The meaning of each v1 criterion is unchanged; compound criteria were split so each states one response, and criteria the spec's test table already assumed were made explicit. Each ID is mapped to its tests, or marked as a gap, in the [test plan](../../test/test-plan-v1.md).
- **Links.** The header points to PRD v8, Spec v10 (now the system HLD) and this component's LLD; sibling links point to current versions.

## 1. Purpose

Shared context is only valuable while it is right. Bad context can come from several places:

- a wrong decision;
- a stale status;
- an agent that misunderstood;
- an injected instruction;
- a secret that slipped through.

Bad context is worse than none, because every agent that reads it is misled. This component makes bad context **easy to spot, quick to contain, and simple to remove**, from a single entry up to everything an agent wrote in a bad session.

## 2. The toolkit at a glance

| Problem | Tool | Who | Reversible |
|---|---|---|---|
| One entry is wrong or outdated | **Flag** it | Any agent or me | Yes |
| An agent or session went bad and wrote a lot | **Quarantine** by source, then **revert** or **release** | Me | Yes |
| A whole project drifted over a period | **Roll back** the scope to a point in time | Me | Yes |
| Content must truly disappear (a secret, poisoned text, personal data) | **Purge** | Me | No (by design) |
| Context slowly goes stale | **Review-by dates** and **`ctxd tidy`** | Automatic, then me | Yes |

## 3. Flag

- **Who can flag.** Any agent with any access level, or I, can flag an entry as `wrong`, `stale`, `duplicate` or `unsafe`, with a one-line reason. Agents are instructed to flag rather than silently ignore an entry the code, the user or the facts contradict.
- **What a flag does.**
  - **Briefs:** the entry drops out of every brief immediately.
  - **Search:** it stays in results, marked flagged and ranked lower, so agents can still see what was claimed and why it was disputed.
- **Review.** Flagged entries appear in `ctxd review` with the reason and who flagged them. Actions:
  - **unflag:** restore the entry;
  - **edit** or **supersede:** fix it;
  - **archive;**
  - **purge.**
- **Unsafe flags.** An `unsafe` flag (suspected injection or secret) also hides the entry from search until I review it.

## 4. Quarantine, revert and release

When an agent misbehaves, I often don't know which entries are bad. I only know the source: "Codex on the laptop this afternoon," or "that one session."

- **Quarantine.** For example, `ctxd quarantine --client codex@laptop --since 3h`, or `--session <id>`, optionally limited to one scope. This hides everything that source created or changed in that window from briefs and search at once. Claims it took are suspended. Quarantine is a single batch with an id, and it replicates to my other machines.
- **Inspect.** `ctxd batch show <id>` lists every affected entry with a diff of what changed.
- **Revert.** `ctxd revert <id>` undoes the batch:
  - entries it created are deleted;
  - entries it edited return to their content from before the window;
  - links it added are removed.

  Revert works through new, recorded changes, so history stays complete and other machines follow. Edits made by other sources after the window are kept; where they conflict with a revert, the entry is marked for my review rather than overwritten.
- **Release.** `ctxd release <id>` lifts the quarantine when the batch turns out fine.
- **Selective handling.** I can revert some entries and release others from the batch view.

## 5. Scope rollback

`ctxd scope rollback <scope> --to "2026-10-17 09:00"` is quarantine and revert for every source in one scope since a point in time. It shows a preview first and requires confirmation.

## 6. Purge

Some content must not survive anywhere: a leaked secret, injected instructions, or personal data that should never have been stored. History and tombstones are the wrong tool for that.

- **Human only.** `ctxd purge <ref> --reason "..."`, with confirmation.
- **What it erases.** The entry's content and the content of every recorded change to it, in the database, the search index and any derived data. What remains is a stub: reference, kind, purge time, reason, who purged it, and a fingerprint of the removed content (so the same text can be recognized and blocked if it reappears).
- **Every machine follows.** The purge travels to other machines like any change. A machine that was offline applies it on its next sync, and any old copies it later receives are stripped on arrival.
- **Backups.** Encrypted backups older than the purge still contain the content until they expire (14 days by default). `ctxd purge --rewrite-backups` removes older backups after making a fresh one, with confirmation.
- **The one exception.** Purge deliberately breaks ctxd's rule that history is never rewritten. It is the only operation that does, and it is always recorded in the audit log.

## 7. Staleness and tidy

- **Review-by dates.** Entries can carry a review-by date. Defaults by kind:

  | Kind | Review after |
  |---|---|
  | `status` | 14 days |
  | `handoff` | 30 days |
  | `fact` and `lesson` | 180 days |
  | Decisions and conventions | Never, unless set |

  Past its date, an entry is demoted in briefs and listed for review.
- **`ctxd tidy`** suggests cleanup in one pass, and I accept or skip each suggestion. It never changes anything on its own. It lists:
  - superseded entries older than 90 days, to archive;
  - entries past review;
  - entries never read in 90 days;
  - likely duplicates, found by similar titles;
  - flags older than a week.
- **Read tracking.** Each machine keeps local, unreplicated counts of when entries were last used in a brief or fetch, to inform tidy.

## 8. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| CH-1 | `context_flag` for agents and `ctxd flag` for me; flagged entries leave briefs immediately and are labeled and demoted in search | FR-37 | P0 |
| CH-2 | `unsafe` flags also hide the entry from search until reviewed | FR-37 | P0 |
| CH-3 | Flagged entries in review with unflag, edit, supersede, archive and purge actions | FR-37 | P0 |
| CH-4 | Quarantine by client, session, time window and optional scope, as one replicated batch | FR-38 | P1 |
| CH-5 | Revert and release per batch, entirely or per entry; conflicts with later edits go to review | FR-38 | P1 |
| CH-6 | Scope rollback to a point in time with preview and confirmation | FR-39 | P1 |
| CH-7 | Purge removes content from entries, history, indexes and derived data on every machine, leaving an audited stub with a fingerprint | FR-40 | P0 |
| CH-8 | Purged content is stripped on arrival from late-syncing machines | FR-40 | P0 |
| CH-9 | Optional backup rewrite after purge | FR-40 | P2 |
| CH-10 | Review-by dates with per-kind defaults; overdue entries demoted and listed | FR-41 | P1 |
| CH-11 | `ctxd tidy` interactive suggestions; never changes anything without confirmation | FR-41 | P2 |
| CH-12 | Agents instructed to flag contradicted entries instead of ignoring them | FR-37 | P0 |

## 9. Acceptance criteria

> Owner: A (agent-generated) by persona `product-writer`, derived from the requirements above; approved by the owner at Gate 1. Verification status per criterion: [test plan](../../test/test-plan-v1.md).

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| CH-AC-1 | Event-driven | When an agent flags a decision as `wrong`, ctxd shall exclude it from the next session's brief and list the flag and its reason in `ctxd review`. | CH-1, CH-3 |
| CH-AC-2 | Event-driven | When the human quarantines one client's work over a time window, ctxd shall hide every entry that client changed in the window, on every node. | CH-4 |
| CH-AC-3 | Event-driven | When a quarantine batch is reverted, ctxd shall restore each edited entry's prior content, tombstone entries created in the window, and mark an entry another client edited after the window as `conflicted`. | CH-5 |
| CH-AC-4 | Event-driven | When an entry is purged, ctxd shall remove its content from search on every node, including a node that was offline during the purge. | CH-7, CH-8 |
| CH-AC-5 | Event-driven | When `ctxd tidy` runs, ctxd shall list a `status` entry that is past its review-by date as due for review. | CH-10, CH-11 |

## 10. Open questions

| # | Question |
|---|---|
| HQ2-1 | Should three or more agents flagging the same entry archive it automatically, or always wait for me? Proposed: always wait |
| HQ2-2 | Should quarantine be triggerable automatically, for example when an agent hits many redaction rejections in a short time? |
| HQ2-3 | Default backup retention after a purge (14 days, or shorter) |
