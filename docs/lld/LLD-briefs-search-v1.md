# ctxd LLD: Briefs, Search, Signals and Digest (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 11 |
| **Implements** | [Briefs and search](../prd/components/PRD-briefs-search-v5.md) (BS-1 to BS-20), [Memory and journal](../prd/components/PRD-memory-journal-v2.md) (MJ-1 to MJ-10) |
| **Owner** | A (agent-generated) by persona `component-designer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/brief/`, `src/search/`, `src/journal/` |
| **Moved from** | Spec v9 section 11; Spec v10 draft W5.1 (digest) and W5.3 (list mode) |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 11. Briefs and search

### 11.1 Brief assembly (deterministic)

Implements [Briefs and search v5](../prd/components/PRD-briefs-search-v5.md). Token estimates use `ceil(chars / 4)`. Sections are filled in priority order until the budget is spent; each section has a soft cap. Lists use each entry's **summary** line (the one-line tier); bodies appear only for the pinned brief, handoffs and pinned conventions (the overview tier). Full bodies are only ever returned by `context_get`.

**Character budget.** A plain `context_brief` tool call is capped at 9,500 characters for `normal`, 3,000 for `micro` and 28,500 for `full`. These are the same numbers the hook-injection cap below uses for `normal`, applied consistently to the tool call too, rather than leaving the tool call's own budget unstated.

**Sources.** A brief reads only the session's working set (10.5): the session scope, the global `_me` and matching pool profiles. Entries with status `flagged`, `quarantined`, `proposed` (except as a count), `deleted` or purged are excluded. Entries past `review_after` are placed last within their section, marked `review due`.

**Hard cap for hook injection.** When a brief is injected by SessionStart, the rendered text is also capped at `session_start_max_chars` (default 9,500). Sections are dropped from the lowest priority upward until it fits; the header, notices and open signals are never dropped.

| Priority | Section | normal | micro |
|---|---|---|---|
| 1 | Header: scope, as-of, node, last sync age, session ref | always | always |
| 2 | Notices: interrupted work (below), lost or taken-over claims, overlaps, drift, conflicts, proposed count, stale sync warning | always | always |
| 3 | Open signals (11.4): up to 5, oldest first, then a count | always | always |
| 4 | Latest status entries (up to 3) | 15% | 30% |
| 5 | Latest handoff (latest per client, up to 2) | 20% | 40% (latest only) |
| 6 | Pinned brief entry | 20% | omitted |
| 7 | Open claims and ready tasks (up to 5) | 10% | titles only, if room |
| 8 | Active conventions (pinned bodies, others summary lines by importance) | 10% | omitted |
| 9 | Recent decisions (last 30 days, up to 5: title plus reason line) | 10% | omitted |
| 10 | Preferences and conventions from global `_me` and the matching `_me.<pool>` (summary lines, by importance) | 5% | 10%, if room |
| 11 | Skill catalog: active skills readable by the session, `- <name>: <description cut to 100 characters> (<author>)`, at most `brief.skill_catalog_chars` (default 600) | 5% | omitted |
| 12 | Relevant active lessons (up to 3 titles, ranked by FTS against the latest status and handoff text) | 3% | omitted |
| 13 | Journal highlights: milestones, breakthroughs and incidents from the last 7 days (up to 3) | 2% | omitted |

`full` raises the caps and includes proposed entries' titles. Truncated sections end with the folder to browse, for example `(more: ctxd://<scope>/decisions/)`. Every entry included increments its `read_stats.briefed`.

**Interrupted-work notice.** Implements [PRD-briefs-search-v5](../prd/components/PRD-briefs-search-v5.md) BS-3. On SessionStart `resume` or `compact`, or on `startup` when this client's previous session in the scope never reached `ended`, the brief checks that session's `sessions.recovery`. If it shows an unfinished phase or an active claim, the brief opens with:

```
Interrupted work: your previous session was working on "<task or phase>" (last seen <time>).
Check recent commits and the working tree before redoing anything; do not repeat side effects.
```

Recovery intent stores only the task id, a phase label and a one-line summary of the last request, sanitized by 6.1. It never stores transcript content.

### 11.2 Search ranking

- FTS5 `bm25(entries_fts, 3.0, 1.0, 2.0)`, weighting title, body and tags.
- **Score:** `0.7 * norm(bm25) + 0.3 * importance` (11.3). Importance carries the kind weight and recency that v5 scored separately.
- **Filters:** `path` restricts results to entries under the folder (4.2); `since` and `until` filter on `created_hlc` for `journal` and `updated_hlc` for other kinds. With `query: "*"` and a time filter, results are listed newest first instead of by relevance: every list-mode row gets `_score = 0`, so the final stable sort keeps the query's own time-descending order in both `importance` flag states. The scope multipliers and the flagged-entry penalty below are relevance adjustments and apply only to scored (non-`"*"`) search, never to list mode (Spec v10 draft W5.3).
- **Excluded by default:** `superseded`, `archived` and `deleted`.
- **Scopes searched:** the named scope plus the global `_me` and matching pool profiles (score multiplied by 0.9 for those). With `scope: "*"`, every scope with level `read` or higher (10.5); results outside the session's own scope are multiplied by 0.8 and always labeled with their scope. Holding scopes are searched only by their owner.
- **The `scope: "*"` multipliers are intentional, not a gap.** With a session scope known, that scope ranks at 1.0, `_me` and its matching pool profiles at 0.9, and everything else at 0.8, exactly as for a named-scope search. With no session scope known (M1's case, and still the case until the session machinery in 9.2 lands and records one), there is no single "home" scope to rank at 1.0 against the rest, so `_me` and profiles rank at 0.9 and everything else at 0.8; this is the same ranking a named-scope search gives its non-home results, applied uniformly because there is no home to compare against yet.
- **Flags and quarantine:** `flagged` entries are returned labeled with their open flags and multiplied by 0.5; entries with an open `unsafe` flag, `quarantined` entries and purged stubs are never returned.
- **Proposed skills** are returned only to their author and the human client (4.3).
- **M5: hybrid with sqlite-vec embeddings via reciprocal rank fusion.** FTS and vector results are each ranked independently, then combined by reciprocal rank fusion (`1 / (k + rank)`, `k = 60`) rather than a weighted blend of raw scores, so the two incomparable score scales (bm25 and cosine distance) never need calibrating against each other. An entry with no vector yet (11.2.1) ranks by FTS alone, exactly as it does with `semantic_search` off; this is normal, not a gap, per [Replication v6](../prd/components/PRD-replication-v6.md) section 4.
- **Snippets:** about 40 words, built with FTS5 `snippet()`.
- **Query escaping.** A free-text query is quoted word by word before it reaches FTS5 `MATCH` (`escapeFtsQuery` in `src/search/fts.ts`), so ordinary punctuation such as a hyphen or a quote never raises an FTS5 syntax error (W6).
- **Quality benchmark.** `npm run bench:search` runs the real search, keyword-only and hybrid, against a fixed fixture set (`test/fixtures/search-bench/`: 200 invented entries, 75 labeled keyword, paraphrase and mixed queries, and precomputed vectors from the pinned model) and reports MRR@10, nDCG@10 and recall@10. A CI test fails if hybrid drops more than 0.03 below the recorded baseline on any of the three, and asserts hybrid beats keyword-only on paraphrase queries, the M5 exit criterion (W6).

### 11.2.1 Embeddings (M5)

Implements [Replication v6](../prd/components/PRD-replication-v6.md) section 3 and [ADR 0004](../adr/0004-embeddings-replicate.md): embedding vectors replicate as event data; FTS does not and still never replicates (11.2, unchanged from v4).

- **Who computes.** A node with the `semantic_search.compute` flag on (default off everywhere; a capable client turns it on) embeds an entry's title and body with a small, fixed, CPU-only model whenever it writes new content for that entry. A node with the flag off never computes, but can still serve hybrid search over vectors that arrived through sync.
- **The event.** A new `part` value, `embedding`, on the existing `events` table (op `update`), carrying `{model_id, dim, vector}` as its payload. `vector` is a plain JSON array of floats; model-specific quantization or packing is left to the materialized `embeddings` table, not the event itself, so the event log stays a portable, model-agnostic record. One embedding event follows the content event that changed the text, in the same write, using the same `rev`.
- **Materializing.** Applying an `embedding` event upserts the `embeddings` table (4), keyed by `(entry_id, model_id)`: a later vector for the same entry and model replaces the earlier one (current content only, matching how FTS always reflects current content, not history). A vector for a different `model_id` is kept alongside, never overwritten, so a model change is additive and detectable rather than a silent mix of incompatible vector spaces in one `sqlite-vec` table.
- **Never conflicts.** Two nodes computing with the same `model_id` for the same text produce the same vector, so there is nothing to merge; [Replication v6](../prd/components/PRD-replication-v6.md) section 5 lists this explicitly. No `entry_siblings` row is ever created for an `embedding` part.
- **Purge.** A purge (7.6) deletes every `embeddings` row for the purged entry, on every node, same as it deletes the entry's other content.
- **Access.** An `embedding` event carries the same scope and vendor policy as the entry it describes; a sealed pool's embeddings are encrypted the same way as its content before they leave the enrolled machine.

`events.part`'s `CHECK` constraint (4) gains `'embedding'` alongside `'content','status','relations','claim','meta'`. `entry_siblings.part`'s own `CHECK` is unchanged (still `'content','status','relations'` only), since an embedding never produces a sibling.

### 11.3 Importance

Implements [Memory and journal](../prd/components/PRD-memory-journal-v2.md) section 5. Computed on read from the entry, its inbound relations and local `read_stats`, so it needs no stored state and no events:

```
importance = 0.35 * weight + 0.25 * links + 0.25 * recency + 0.15 * use      (each part in 0..1)
weight  = kind weight; for journal, the significance weight (table below)
links   = min(1, (inbound + 2 * causal_inbound) / 10)   causal = caused, resolved, blocks
recency = 0.5 ^ (age_days / 90)                          age from updated_hlc
use     = min(1, log2(1 + reads + briefed / 4) / 6)
```

| Kind | Weight | Kind | Weight |
|---|---|---|---|
| `brief`, `decision` | 1.0 | `fact`, `handoff`, `task` | 0.6 |
| `convention` | 0.9 | `note` | 0.4 |
| `preference` | 0.85 | `pointer` | 0.3 |
| `skill`, `lesson` | 0.8 | `journal` `incident` or `blocker` | 0.95 |
| `status` | 0.7 | `journal` `milestone` or `breakthrough` | 0.8 |
| | | `journal` `decision` | 0.7 |
| | | `journal` `routine` | 0.3 |

- **Uses.** Ranking within brief sections, search scores, folder overviews, and `ctxd tidy`, which suggests archiving entries with importance below 0.15 that are older than 180 days and unread for 90.
- **Never alone.** Importance never archives, hides or deletes anything by itself.
- **Explained.** `ctxd show <ref> --why` prints the four parts and their inputs.
- **Local.** Two nodes can rank slightly differently, because `use` comes from local reads. Content and status still converge.

### 11.4 Open signals

Implements [Memory and journal](../prd/components/PRD-memory-journal-v2.md) section 4. The `signals` table is materialized during apply, so every node derives the same rows from the same events:

| Source | Opens when | Closes when |
|---|---|---|
| `journal` | A `journal` entry with significance `blocker` or `incident` becomes `active` | A `resolved` link to it counts (below), or it is archived, superseded, quarantined, deleted or purged |
| `task` | An `active` task first has a `blocks` link to a task that has become `active` (at the earliest such link) | A `resolved` link to it counts, it leaves the live states, or every task it blocks has left them or been unlinked |
| `flag` | An entry gets its first open flag | All its flags are resolved (7.6.1) |

- **One row per entry and source.** A flagged blocker has both a `journal` row and a `flag` row.
- **Flagged and conflicted entries stay live.** Flagging a blocker does not close its signal; only the rules above do.
- **Same-scope only.** A `resolved` link counts only when the linking entry is in the same scope as the entry it closes; resolution is never evaluated across scopes. This is a rule, not an accident of implementation: scanning every readable scope's relations for every open signal, on every write, is considerably more expensive than a same-scope check, and cross-scope resolution is rare enough in practice that the cost is not worth paying. A `resolved` link from another scope is still stored as an ordinary relation; it simply does not close the signal.
- **When a resolved link counts.** From the later of the link and the approval of the entry holding it, so a proposed fix closes nothing until approved. Once counted, a resolution stands: archiving the fix later, or removing the link afterwards, does not reopen the signal.
- **Removed links close, never erase.** Removing a `blocks` link closes the task signal at the removal, so time to resolve is kept.
- **Time to resolve.** `resolved_hlc` minus `opened_hlc`, reported by the weekly digest.
- **Briefs.** Open signals for the session's working set appear in section 3 of every brief, with their age, for example `BLOCKER (2d): waiting on the test fixture for sealed pools, ctxd:ctxd/01JAB...`. Signals in scopes the session cannot read are never shown (10.7).

### 11.5 Weekly digest

Implements [Memory and journal](../prd/components/PRD-memory-journal-v2.md) section 3.

- **Who writes it.** Only the node named in `journal.digest_node` writes digests, as the `human` client, on `journal.digest_weekday` after 18:00 in that node's time zone, for each scope with at least one new event that week. A node that was offline catches up on its next start.
- **Idempotent.** The `request_id` is `digest:<scope_id>:<ISO week, e.g. 2026-W42>`, with the week taken from the digest node's local date (not UTC, which would move a Sunday evening run into the next week), so retries and restarts never duplicate a digest.
- **Contents.** Assembled without a model: counts of new entries by kind; milestones and breakthroughs (titles); blockers and incidents opened and resolved, with time to resolve; decisions made (by `approved_hlc`, falling back to `created_hlc` for a decision that was active from creation, Spec v10 draft W5.1); lessons, preferences and skills added; and sessions and commits from `auto` journal entries.
- **Shape.** A `journal` entry, significance `routine`, tags `digest` and the ISO week, at most 1,000 characters of body; longer lists end with a folder path.
- **Optional summary.** A local model may add a prose summary in M6, labeled as machine-written.

### 11.6 Local model proposals

The `local_model` flag is off by default. When enabled, the server may send active entry text to the configured loopback HTTP model. Non-loopback endpoints are rejected before a request is made.

The model returns JSON with optional `summary` and `lesson` strings. ctxd stores each result as a new proposal through the normal write, sanitization, access and event path. Summary proposals are `brief` entries. Lesson suggestions are `lesson` entries. Both carry `machine-written`, `local-model` and model identity tags plus a `derived_from` relation to the source. The local model client receives only propose access to each target scope.

The source revision is part of each request id. A retry cannot create duplicates, while a later source revision may produce a new proposal. A timeout, invalid response or unavailable model leaves the deterministic source summary unchanged and does not block hooks or ordinary writes.
