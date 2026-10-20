# ctxd LLD: Context Hygiene (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 7.6 |
| **Implements** | [Context hygiene](../prd/components/PRD-context-hygiene-v2.md) (CH-1 to CH-12) |
| **Owner** | A (agent-generated) by persona `component-designer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/hygiene/`, `src/store/purge.ts`, `src/store/rollback.ts` |
| **Moved from** | Spec v9 section 7.6 |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

### 7.6 Cleanup operations

Implements [PRD-context-hygiene-v2](../prd/components/PRD-context-hygiene-v2.md). All of these are events that replicate and converge like any other, except where purge says otherwise.

#### 7.6.1 Flag and unflag

- **`flag`** (status part): any client with any access to the entry's scope (including `read`), or the human client.
  - It appends a `flags` row, records `status_before`, and sets status `flagged`.
  - An entry already flagged gets an additional flag row; its status is unchanged.
  - With `problem = unsafe`, search excludes the entry until it is resolved.
- **`unflag`** (human only): restores `status_before` and closes all open flags on the entry with the resolution `unflagged`. Edit, supersede, archive and purge also close open flags with that action as the resolution.

#### 7.6.2 Quarantine

`ctxd quarantine` (human only) takes a selector: `--client`, `--session`, `--since`, `--until` and `--scope`, with at least one of client or session.

1. **Select events.** Events in the window matching the selector, on content, relations and status parts.
2. **Group them.** Group the selected events by entry into `batch_members`, noting whether each entry was created inside the window.
3. **Hide the entries.** Append a `quarantine` event per entry (status part), recording `status_before` and setting `quarantined`.
4. **Suspend claims.** Active claims by the selected client in the affected scopes are marked suspended: they no longer block other agents, and overlaps ignore them.

#### 7.6.3 Revert

Revert applies per batch or per entry.

- **Created in the window:** a `delete` event (tombstone).
- **Edited in the window:**
  - **Content:** an `update` event restoring the content part to its value just before `first_event`, taken from the earliest selected event's `prev`.
  - **Relations:** `unrelate` events for links added in the window.
  - **Status:** restored to `status_before`.
- **Later edits by other sources.** If an event *after* the window from another source touched the same part, the entry is not reverted. Instead it becomes `conflicted`, with the would-be reverted content stored as a sibling, and the member outcome is `conflict`.
- **Claims.** Suspended claims are released with `changed_files` unknown.
- **Batch state.** The batch moves to `reverted`, or to `partial` when some members are released instead.

#### 7.6.4 Release

`unquarantine` events restore each member's `status_before`; suspended claims resume; the batch moves to `released` (or `partial`).

#### 7.6.5 Scope rollback

`ctxd scope rollback <scope> --to <time>` creates a `rollback` batch: all events in the scope after `<time>` from every source, selected and reverted as in 7.6.2 and 7.6.3 in one step. A preview (entry count, diff summary) is printed first, and confirmation is required.

#### 7.6.6 Purge

`ctxd purge <ref> --reason <text>` (human only, confirmed). It appends a `purge` event (meta part) carrying the entry id, the reason, the fingerprint (SHA-256 of the canonical content being removed), and the entry's `scope_id`, `kind` and `slug` as of purge time. Carrying the latter three turns applying a purge into a reconstruction, not just an edit: it needs nothing else from the entry's prior history to produce the stub row, which matters because step 2 below neuters that prior history, including the create event that would otherwise supply them. Applying a purge, on the originating node and on every node that receives it:

1. **Erase content in place, as an upsert.** In one transaction, upsert the `entries` row keyed on `entry_id`: `title = '[purged]'`, empty `summary`, `body` and `tags`, `purged_at` and `purge_fingerprint` set, and `scope_id`/`kind`/`slug` from the event's payload. This reconstructs the row from nothing when it is not already present (for example mid-rebuild, after the create event replayed neutered per step 2), and normalizes every placeholder field (`content_rev`, `content_version`, `status`, `status_rev`, `relations_rev`, `created_by`, `updated_by`, `created_hlc`, `updated_hlc`) to values derived from the purge event itself either way, so the row materializes identically regardless of replay order (the general convergence property, 7.3). `status` becomes `archived`; nothing reads a purged entry's status to decide behavior; `context_get` and search both key off `purged_at` instead. Delete the FTS row and any vector rows. Remove the entry's relations, and mark relations targeting it as `[purged]`.
2. **Erase history.** Rewrite `payload` and `prev` of every stored event for that entry to `{"purged": true}`. Event ids, sequence numbers and HLCs are kept, so sync cursors stay valid. This is the only operation that rewrites stored events. (With signed events in M6, signatures cover a payload hash that the purge keeps, so verification still passes.)
3. **Strip late arrivals.** When a node later receives any event for a purged entry (from a peer that was offline), it stores the event with its payload replaced by `{"purged": true}` before applying it, so the content never lands.
4. **Block reinsertion.** Writes whose content fingerprint matches a recorded purge fingerprint are rejected with `VALIDATION` ("this content was purged").
5. **Backups.** `--rewrite-backups` makes a fresh encrypted backup and deletes older ones after confirmation. Otherwise older backups expire on their normal schedule.

**Rebuild.** `ctxd rebuild` replays every event from scratch (14). Because step 1 above is an upsert driven entirely by the purge event's own payload, a rebuild after a purge reproduces the purged entry's stub row exactly as it was before the rebuild, in any event order: the entry is never absent from `entries`.

#### 7.6.7 Review-by and tidy

- **`review_after`** is set at creation from per-kind defaults ([Knowledge model](../prd/components/PRD-knowledge-model-v4.md) 3.1), or explicitly.
- **`ctxd tidy`** reads local `read_stats` and entries. It proposes one action per finding (archive, review, merge, or close a flag) and applies only the ones I confirm, as ordinary events.
