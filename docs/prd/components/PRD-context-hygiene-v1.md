# ctxd Component PRD: Context Hygiene (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-18 |
| **Parent** | [ctxd PRD v4](../PRD-v4.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v2.md), [Persona pools and access](PRD-pools-access-v1.md), [Hooks and agent lifecycle](PRD-hooks-v3.md), [Claims and write intent](PRD-claims-v3.md), [Trust and safety](PRD-trust-safety-v3.md), [Replication](PRD-replication-v3.md), [Briefs and search](PRD-briefs-search-v3.md) |
| **Spec** | [Spec v4](../../spec/SPEC-v4.md) sections 4 (`flags`, `batches`, purge fields), 7.6, 8.2 (`context_flag`), 11 and 13 |
| **Parent requirements elaborated** | FR-37 to FR-41 |

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

- An agent flags a decision as wrong; the next session's brief no longer contains it, and review shows the flag and reason.
- Quarantining an afternoon of one agent's work hides all of it on both machines; reverting restores every edited entry's earlier content and deletes the new ones, while another agent's later edit to one of them is preserved and sent to review.
- After a purge, searching for a phrase from the purged entry returns nothing on any machine, including one that was offline during the purge.
- `ctxd tidy` lists a status entry not updated in three weeks.

## 10. Open questions

| # | Question |
|---|---|
| HQ2-1 | Should three or more agents flagging the same entry archive it automatically, or always wait for me? Proposed: always wait |
| HQ2-2 | Should quarantine be triggerable automatically, for example when an agent hits many redaction rejections in a short time? |
| HQ2-3 | Default backup retention after a purge (14 days, or shorter) |
