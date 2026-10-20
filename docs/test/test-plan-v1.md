# ctxd Test Plan (v1): Acceptance Criteria to Tests

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 verification: maps every acceptance criterion to the tests that verify it |
| **Owner** | A (agent-generated) by persona `test-architect`; the owner reviews coverage, not each case, at Gate 3 |
| **Inputs** | Acceptance criteria in the current component PRDs ([PRD v8](../prd/PRD-v8.md) section 6.1 lists them); tests in `test/unit/` and `test/conformance/` |
| **Strategy** | [Spec v10](../spec/SPEC-v10.md) section 14 (test layers and tooling) |

Every acceptance criterion in the component PRDs has an ID (`<prefix>-AC-n`). This plan maps each ID to the tests that verify it. It was first mapped at commit `9ffeea9` and updated as the W1 to W6 workstreams merged; each link is re-resolved by test title, so line numbers stay current. Counts: **89 criteria**; Covered: 39, Diverges: 1, Gap: 8, Partial: 41.

| Status | Meaning |
|---|---|
| Covered | The named tests assert the criterion as written |
| Partial | Tests exercise the mechanism, but not every clause of the criterion; the note says what is missing |
| Gap | No test found; the criterion is built but unverified |
| Not built | The feature is not implemented yet (milestone named) |
| Diverges | The code contradicts the spec; raised for the owner before any fix |

**Rules.** A new criterion gets a row here in the same change that adds it. From now on, a new or changed test that verifies a criterion names its ID in the test title or a comment (for example `// HK-AC-5`), so this map can later be checked mechanically; the existing tests below were mapped by reading them. A gap is closed by adding the test, then changing the row; never by loosening the criterion.

## Gaps to close first

| ID | Status | Criterion | Note |
|---|---|---|---|
| BS-AC-5 | Diverges | The SessionStart brief shall never exceed `session_start_max_chars`, and the header, notices and open signals shall survive the cut. | Code contradicts Spec 11.1: `src/hooks/readMoments.ts` cuts the text at the limit and appends a marker (up to 2 characters over, and it can cut open signals) instead of dropping sections lowest priority first. Raised for the owner; then fix the code and add the test. |
| CL-AC-3 | Gap | When the human client claims with `take_over: true` in a `strict` scope, ctxd shall grant the claim despite the overlap. | No test exercises the human override. |
| FF-AC-2 | Gap | When `sync` is switched back on after a period off, the node shall converge with its peers with no event lost. | No off-then-on test for the `sync` flag. |
| FF-AC-4 | Gap | The `tools/list` payload shall be byte-for-byte identical with every flag off and with every flag on. | `toolDefinitions()` takes no flag input by design, but no test compares the two payloads. |
| MI-AC-4 | Gap | If an inbox entry contains a secret, then ctxd shall redact it before storage. | No inbox test. The pull engine writes through the agent write path, which rejects a secret (`REDACTED_SECRET`) rather than redacting it; the owner should confirm whether MI-5 means reject or redact. |
| MI-AC-11 | Gap | While `mobile_inbox` is off, every ctxd hook shall still exit 0. | No hook test with the flag off. |
| MI-AC-12 | Gap | ctxd shall keep inbox API tokens and encryption keys only in the macOS Keychain, never in a repository or configuration file. | No test for `ctxd inbox set-token`. |
| PA-AC-11 | Gap | When the human runs `ctxd hold adopt`, ctxd shall move the holding scope's approved entries into the project scope and add the agent to the pool in one step. | No test for `ctxd hold adopt`. |
| TS-AC-7 | Gap | When the human exports a scope that contains a home-directory path, ctxd shall print a categorized warning and ask for confirmation before writing. | Import preflight is tested (`mirror.test.ts:147`); export warnings are not. |

## BS: Briefs and search

Criteria: [PRD-briefs-search-v5](../prd/components/PRD-briefs-search-v5.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| BS-AC-1 | Partial | [`brief.test.ts:62`](../../test/unit/brief.test.ts#L62) includes the latest status entry and the pinned brief body, but not in micro size<br>[`read-moments.test.ts:98`](../../test/unit/read-moments.test.ts#L98) builds a normal-size brief for a bound scope on startup, containing real content | No test asserts the handoff and claim sections together within budget. |
| BS-AC-2 | Partial | [`tools-read.test.ts:78`](../../test/unit/tools-read.test.ts#L78) finds a matching entry by full-text query, scoped to a readable scope<br>[`hybrid-search.test.ts:162`](../../test/unit/hybrid-search.test.ts#L162) ranks an entry matching on both FTS and vector above one matching on only the vector side | Top-3 rank is not asserted against a corpus. |
| BS-AC-3 | Covered | [`tool-footprint.test.ts:8`](../../test/unit/tool-footprint.test.ts#L8) keeps the tools/list payload under about 1,500 tokens |  |
| BS-AC-4 | Partial | [`brief.test.ts:122`](../../test/unit/brief.test.ts#L122) surfaces an open signal from a blocker journal entry (store/write.ts syncs signals on every write) | Only one size is exercised. |
| BS-AC-5 | Diverges | None | Code contradicts Spec 11.1: `src/hooks/readMoments.ts` cuts the text at the limit and appends a marker (up to 2 characters over, and it can cut open signals) instead of dropping sections lowest priority first. Raised for the owner; then fix the code and add the test. |
| BS-AC-6 | Covered | [`coerce.test.ts:29`](../../test/unit/coerce.test.ts#L29) coerces only enum fields, reports what changed, and then validates<br>[`coerce.test.ts:47`](../../test/unit/coerce.test.ts#L47) handles array fields and per-tool action tables |  |

## CL: Claims and write intent

Criteria: [PRD-claims-v4](../prd/components/PRD-claims-v4.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| CL-AC-1 | Partial | [`claim.test.ts:144`](../../test/unit/claim.test.ts#L144) reports an overlap under the warn policy without refusing (default scope policy) | The brief notice is not asserted. |
| CL-AC-2 | Covered | [`claim.test.ts:156`](../../test/unit/claim.test.ts#L156) refuses an overlapping claim under the strict policy, writing nothing |  |
| CL-AC-3 | Gap | None | No test exercises the human override. |
| CL-AC-4 | Covered | [`claim.test.ts:191`](../../test/unit/claim.test.ts#L191) releases a claim, computing drift against agent-supplied changed_files<br>[`intent.test.ts:79`](../../test/unit/intent.test.ts#L79) reports changed files outside declared paths<br>[`claim.test.ts:323`](../../test/unit/claim.test.ts#L323) release derives changed_files and drift from journaled commit pointers when not supplied |  |
| CL-AC-5 | Covered | [`claim.test.ts:121`](../../test/unit/claim.test.ts#L121) returns CLAIM_STALE for an expired claim without take_over, and allows take_over to proceed<br>[`claim.test.ts:286`](../../test/unit/claim.test.ts#L286) reports the real holder session state and recent commit pointers in CLAIM_STALE |  |
| CL-AC-6 | Covered | [`sync-claims.test.ts:122`](../../test/unit/sync-claims.test.ts#L122) the earlier claim_hlc wins regardless of application order, and the loser is recorded as a lost sibling<br>[`sync-claims.test.ts:233`](../../test/unit/sync-claims.test.ts#L233) records a claim_overlaps row in both directions when a replicated claim's paths overlap an already-active claim<br>[`sync-partition-property.test.ts:371`](../../test/unit/sync-partition-property.test.ts#L371) is deterministic across random sequences of operations, random partitions, heals and delivery order |  |

## CH: Context hygiene

Criteria: [PRD-context-hygiene-v2](../prd/components/PRD-context-hygiene-v2.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| CH-AC-1 | Partial | [`flag.test.ts:65`](../../test/unit/flag.test.ts#L65) flags an entry and sets status to flagged, recording status_before | Brief exclusion and the review listing are not asserted. |
| CH-AC-2 | Covered | [`hygiene.test.ts:111`](../../test/unit/hygiene.test.ts#L111) hides only the selected client's entries, recording status_before<br>[`sync-partition-property.test.ts:310`](../../test/unit/sync-partition-property.test.ts#L310) converges to identical state after a scripted mix of content, claims, purges, quarantine and revert, applied under partition and healed in varying order |  |
| CH-AC-3 | Covered | [`hygiene.test.ts:161`](../../test/unit/hygiene.test.ts#L161) tombstones an entry created inside the window<br>[`hygiene.test.ts:179`](../../test/unit/hygiene.test.ts#L179) restores prior content for an entry edited inside the window, leaving an entry created before the window untouched<br>[`hygiene.test.ts:203`](../../test/unit/hygiene.test.ts#L203) marks a member conflicted, keeping it untouched, when another client edits the same part after the window |  |
| CH-AC-4 | Partial | [`purge.test.ts:63`](../../test/unit/purge.test.ts#L63) erases title, summary, body and tags, setting purged_at and a fingerprint<br>[`sync-purge.test.ts:125`](../../test/unit/sync-purge.test.ts#L125) stores the event with payload {purged:true}, not its real content, and never un-erases the entry | No test searches on a node that received the purge through sync. |
| CH-AC-5 | Covered | [`tidy.test.ts:114`](../../test/unit/tidy.test.ts#L114) finds an entry past its review_after date, to review<br>[`write.test.ts:457`](../../test/unit/write.test.ts#L457) sets status to 14 days, handoff to 30, fact and lesson to 180, preference to 365 |  |

## FF: Feature flags

Criteria: [PRD-feature-flags-v2](../prd/components/PRD-feature-flags-v2.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| FF-AC-1 | Partial | [`hooks.test.ts:102`](../../test/conformance/hooks.test.ts#L102) CTXD_FEATURE_HOOKS=0: SessionStart exits 0 with no output at all (the master switch) | Only SessionStart is replayed. |
| FF-AC-2 | Gap | None | No off-then-on test for the `sync` flag. |
| FF-AC-3 | Covered | [`features.test.ts:45`](../../test/unit/features.test.ts#L45) writes [features] into config.toml and the new value takes effect on the next read<br>[`write-moments.test.ts:158`](../../test/unit/write-moments.test.ts#L158) hooks.nudge off (PRD-feature-flags-v1): never blocks even past the turns threshold, but still checkpoints |  |
| FF-AC-4 | Gap | None | `toolDefinitions()` takes no flag input by design, but no test compares the two payloads. |

## FS: Filesystem view

Criteria: [PRD-filesystem-view-v2](../prd/components/PRD-filesystem-view-v2.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| FS-AC-1 | Partial | [`cli-introspection.test.ts:193`](../../test/unit/cli-introspection.test.ts#L193) tree walks the root into scopes without crashing<br>[`cli-introspection.test.ts:186`](../../test/unit/cli-introspection.test.ts#L186) read prints a folder overview given a valid path | The folder list and summaries are not asserted. |
| FS-AC-2 | Partial | [`tools-read.test.ts:216`](../../test/unit/tools-read.test.ts#L216) resolves nothing for a ref in a scope the client cannot read (regression: must not throw or leak) | A root listing under a persona is not asserted. |
| FS-AC-3 | Partial | [`mirror.test.ts:53`](../../test/unit/mirror.test.ts#L53) honors status and review date frontmatter as events | Human-client authorship of the event is not asserted. |
| FS-AC-4 | Partial | [`mirror.test.ts:73`](../../test/unit/mirror.test.ts#L73) writes a conflict copy for a stale revision and does not apply it | The review item (`mirror_conflicts` row) is not asserted. |
| FS-AC-5 | Covered | [`tools-read.test.ts:156`](../../test/unit/tools-read.test.ts#L156) restricts results to a path's folder prefix, deriving the scope from the path |  |

## HK: Hooks and agent lifecycle

Criteria: [PRD-hooks-v6](../prd/components/PRD-hooks-v6.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| HK-AC-1 | Partial | [`read-moments.test.ts:145`](../../test/unit/read-moments.test.ts#L145) session-start resolves scope through scope_map and returns a real brief<br>[`hooks.test.ts:70`](../../test/conformance/hooks.test.ts#L70) ${fixture.client} ${fixture.event} (${fixture.variant}) | Handoff and claim sections are not asserted together. |
| HK-AC-2 | Covered | [`write-moments.test.ts:130`](../../test/unit/write-moments.test.ts#L130) blocks once the turns threshold is reached, then the loop guard stops a second block<br>[`write-moments.test.ts:228`](../../test/unit/write-moments.test.ts#L228) writes a mechanical journal entry with client, branch, HEAD and changed-file count |  |
| HK-AC-3 | Partial | [`hooks-core.test.ts:161`](../../test/unit/hooks-core.test.ts#L161) returns undefined (never breaks) when the client or node doesn't exist<br>[`hooks-core.test.ts:189`](../../test/unit/hooks-core.test.ts#L189) resolves to undefined, not a rejection, when the function exceeds the deadline<br>[`read-moments.test.ts:117`](../../test/unit/read-moments.test.ts#L117) falls back to the spec-literal unavailable notice if assembling the brief throws | No test stops a real server mid-session. |
| HK-AC-4 | Covered | [`hooks.test.ts:70`](../../test/conformance/hooks.test.ts#L70) ${fixture.client} ${fixture.event} (${fixture.variant})<br>[`hooks.test.ts:50`](../../test/conformance/hooks.test.ts#L50) every adapter event has at least one fixture<br>[`hooks.test.ts:92`](../../test/conformance/hooks.test.ts#L92) every fixture whose event cannot block exits 0 |  |
| HK-AC-5 | Partial | [`crash-sweep.test.ts:65`](../../test/unit/crash-sweep.test.ts#L65) finalizes a session silent longer than the grace period as ended, recording ended_by: sweep<br>[`crash-sweep.test.ts:111`](../../test/unit/crash-sweep.test.ts#L111) is idempotent: sweeping twice only finalizes a crashed session once<br>[`crash-sweep.test.ts:139`](../../test/unit/crash-sweep.test.ts#L139) writes the mechanical journal entry when the session recorded a cwd and scope | The claim release by the sweep is not asserted. |
| HK-AC-6 | Covered | [`scope.test.ts:35`](../../test/unit/scope.test.ts#L35) origin normalization (SPEC v3 section 3)<br>[`scope.test.ts:104`](../../test/unit/scope.test.ts#L104) resolves via scope_repos when the repository is bound<br>[`scope.test.ts:58`](../../test/unit/scope.test.ts#L58) reads origin from .git/config, from subdirectories and worktrees |  |
| HK-AC-7 | Partial | [`scope.test.ts:89`](../../test/unit/scope.test.ts#L89) honors the environment flag<br>[`scope.test.ts:94`](../../test/unit/scope.test.ts#L94) matches absolute and anywhere patterns | Zero server calls are not asserted through the CLI. |
| HK-AC-8 | Partial | [`write-moments.test.ts:328`](../../test/unit/write-moments.test.ts#L328) journals a successful git commit, linked to its sha, and is idempotent on replay<br>[`digest.test.ts:192`](../../test/unit/digest.test.ts#L192) counts an auto-tagged commit entry and an auto-tagged session entry separately | The day view total is not asserted. |

## KM: Knowledge model

Criteria: [PRD-knowledge-model-v4](../prd/components/PRD-knowledge-model-v4.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| KM-AC-1 | Partial | [`sync-partition-property.test.ts:371`](../../test/unit/sync-partition-property.test.ts#L371) is deterministic across random sequences of operations, random partitions, heals and delivery order | No named test for this exact status-plus-relation case. |
| KM-AC-2 | Partial | [`model-refs.test.ts:27`](../../test/unit/model-refs.test.ts#L27) finds references in free text such as commit messages<br>[`tools-read.test.ts:264`](../../test/unit/tools-read.test.ts#L264) follows a supersedes relation as a related entry when related: true | No test resolves an old reference to its replacement. |
| KM-AC-3 | Partial | [`cli-introspection.test.ts:75`](../../test/unit/cli-introspection.test.ts#L75) prints one line per event, oldest first | Machine and prior value columns are not asserted. |
| KM-AC-4 | Partial | [`write.test.ts:200`](../../test/unit/write.test.ts#L200) rejects agent writes that match a secret detector, and records a rejection row | The test reads only the error code; assert that `detail` holds no part of the secret. |
| KM-AC-5 | Partial | [`write.test.ts:115`](../../test/unit/write.test.ts#L115) rejects a content update on an immutable kind | The test uses a decision, not a journal entry. |
| KM-AC-6 | Partial | [`paths.test.ts:25`](../../test/unit/paths.test.ts#L25) lays out each kind<br>[`paths.test.ts:40`](../../test/unit/paths.test.ts#L40) round-trips every entry path through the parser | A rename followed by a path lookup is not asserted. |
| KM-AC-7 | Covered | [`coerce.test.ts:62`](../../test/unit/coerce.test.ts#L62) requires body except for journal and allows significance only on journal |  |

## MJ: Memory and journal

Criteria: [PRD-memory-journal-v2](../prd/components/PRD-memory-journal-v2.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| MJ-AC-1 | Partial | [`memory-journal.test.ts:77`](../../test/unit/memory-journal.test.ts#L77) creates a _me-scoped entry with the given kind, default scope | Covers the CLI path; the agent path and the cross-client brief are not asserted. |
| MJ-AC-2 | Partial | [`memory-journal.test.ts:157`](../../test/unit/memory-journal.test.ts#L157) filters entries by `--day`, a single calendar day | Order and entry types are not asserted. |
| MJ-AC-3 | Partial | [`brief.test.ts:122`](../../test/unit/brief.test.ts#L122) surfaces an open signal from a blocker journal entry (store/write.ts syncs signals on every write)<br>[`journal.test.ts:69`](../../test/unit/journal.test.ts#L69) opens for blockers and incidents that became active, and stays open when flagged | Only the normal size is exercised, as for BS-AC-4. |
| MJ-AC-4 | Covered | [`digest.test.ts:168`](../../test/unit/digest.test.ts#L168) reports a blocker opened and resolved this week, with time to resolve |  |
| MJ-AC-5 | Covered | [`cli-introspection.test.ts:122`](../../test/unit/cli-introspection.test.ts#L122) `--why` prints the importance score and its four parts (SPEC 11.3)<br>[`importance.test.ts:57`](../../test/unit/importance.test.ts#L57) explains itself with the same numbers |  |

## MI: Mobile inbox

Criteria: [PRD-mobile-inbox-v2](../prd/components/PRD-mobile-inbox-v2.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| MI-AC-1 | Covered | [`inbox-pull.test.ts:140`](../../test/unit/inbox-pull.test.ts#L140) is idempotent: re-pulling the same inboxEntryId after it was applied is a no-op, not a duplicate<br>[`inbox-delivery-property.test.ts:57`](../../test/unit/inbox-delivery-property.test.ts#L57) any sequence of batches, each a shuffled and possibly-repeating subset of a fixed id pool, ends with exactly one entry per distinct id once drained |  |
| MI-AC-2 | Covered | [`inbox-crash-recovery.test.ts:54`](../../test/unit/inbox-crash-recovery.test.ts#L54) an ack that fails right after a successful apply does not lose the apply, and the retry does not duplicate it |  |
| MI-AC-3 | Partial | [`inbox-pull.test.ts:120`](../../test/unit/inbox-pull.test.ts#L120) rejects an entry that fails schema validation, and still acks it so it doesn't jam the queue<br>[`inbox-pull.test.ts:130`](../../test/unit/inbox-pull.test.ts#L130) rejects a body over the 16 KB bound (MI-5) | The 32 KB total payload bound is not exercised. |
| MI-AC-4 | Gap | None | No inbox test. The pull engine writes through the agent write path, which rejects a secret (`REDACTED_SECRET`) rather than redacting it; the owner should confirm whether MI-5 means reject or redact. |
| MI-AC-5 | Covered | [`inbox-pull.test.ts:78`](../../test/unit/inbox-pull.test.ts#L78) applies an entry for an allowlisted scope as proposed, tagged with its origin |  |
| MI-AC-6 | Covered | [`inbox-pull.test.ts:97`](../../test/unit/inbox-pull.test.ts#L97) holds an entry for a scope the client has no grant for, rather than applying or silently dropping it |  |
| MI-AC-7 | Partial | [`inbox-pull.test.ts:78`](../../test/unit/inbox-pull.test.ts#L78) applies an entry for an allowlisted scope as proposed, tagged with its origin | The origin tag is asserted; capture time and reference tags are not. |
| MI-AC-8 | Partial | [`inbox-pull.test.ts:108`](../../test/unit/inbox-pull.test.ts#L108) rejects a home-replication scope outright, without holding it for review (MI-7)<br>[`inbox-publish-briefs.test.ts:62`](../../test/unit/inbox-publish-briefs.test.ts#L62) skips a local-only scope and a home-replication scope even when allowlisted | Pull tests cover a `home` scope; `local-only` and sealed exclusion are tested only for brief publishing. |
| MI-AC-9 | Covered | [`inbox-pull.test.ts:63`](../../test/unit/inbox-pull.test.ts#L63) makes zero transport calls when mobile_inbox is off<br>[`cli-inbox.test.ts:44`](../../test/unit/cli-inbox.test.ts#L44) makes no transport calls and returns 0 when mobile_inbox is off |  |
| MI-AC-10 | Covered | [`cli-inbox.test.ts:44`](../../test/unit/cli-inbox.test.ts#L44) makes no transport calls and returns 0 when mobile_inbox is off<br>[`cli-inbox.test.ts:73`](../../test/unit/cli-inbox.test.ts#L73) reports mobile_inbox off without calling the transport |  |
| MI-AC-11 | Gap | None | No hook test with the flag off. |
| MI-AC-12 | Gap | None | No test for `ctxd inbox set-token`. |

## PA: Persona pools and access

Criteria: [PRD-pools-access-v3](../prd/components/PRD-pools-access-v3.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| PA-AC-1 | Partial | [`access.test.ts:51`](../../test/unit/access.test.ts#L51) grants through tag membership and denies by default<br>[`tools-read.test.ts:99`](../../test/unit/tools-read.test.ts#L99) excludes results from a scope the client has no access to (default deny)<br>[`claim.test.ts:244`](../../test/unit/claim.test.ts#L244) rejects claim/release below propose access, but allows list at read | The rejection row is not asserted for reads. |
| PA-AC-2 | Covered | [`access.test.ts:100`](../../test/unit/access.test.ts#L100) narrows a multi-pool agent to the current project's persona<br>[`access.test.ts:120`](../../test/unit/access.test.ts#L120) limits a multi-pool agent to its assumed pool |  |
| PA-AC-3 | Partial | [`access.test.ts:68`](../../test/unit/access.test.ts#L68) lets every agent read global _me, writing only at propose | The auto-accept override case is not asserted. |
| PA-AC-4 | Covered | [`access.test.ts:63`](../../test/unit/access.test.ts#L63) honors temporary grants only until they expire |  |
| PA-AC-5 | Covered | [`access.test.ts:120`](../../test/unit/access.test.ts#L120) limits a multi-pool agent to its assumed pool<br>[`access.test.ts:127`](../../test/unit/access.test.ts#L127) ignores assumed pools the agent is no longer a member of |  |
| PA-AC-6 | Partial | [`scope.test.ts:58`](../../test/unit/scope.test.ts#L58) reads origin from .git/config, from subdirectories and worktrees | Also enforced by the AGENTS.md no-real-names rule at review. |
| PA-AC-7 | Partial | [`sealed.test.ts:95`](../../test/unit/sealed.test.ts#L95) routes each unlocked request to the sealed database without copying plaintext into main<br>[`sealed.test.ts:146`](../../test/unit/sealed.test.ts#L146) rejects unlock when the key provider is locked | The Touch ID prompt is a manual check on a real Mac. |
| PA-AC-8 | Covered | [`access.test.ts:139`](../../test/unit/access.test.ts#L139) returns an opaque reference for unreadable targets<br>[`access.test.ts:146`](../../test/unit/access.test.ts#L146) returns an opaque reference for locked sealed targets even when readable |  |
| PA-AC-9 | Partial | [`access.test.ts:105`](../../test/unit/access.test.ts#L105) gives an out-of-pool or unassigned agent only global _me | The notice text is not asserted. |
| PA-AC-10 | Covered | [`write.test.ts:220`](../../test/unit/write.test.ts#L220) holds a write to a scope outside the client's pools and opens an access request<br>[`access.test.ts:73`](../../test/unit/access.test.ts#L73) holds every write from an unassigned agent outside its own holding scope |  |
| PA-AC-11 | Gap | None | No test for `ctxd hold adopt`. |
| PA-AC-12 | Partial | [`write.test.ts:239`](../../test/unit/write.test.ts#L239) holds a write to a scope that belongs to no pool, opening an access_requests row with pool_ids '[]' (SPEC v7 section 6 step 1)<br>[`write.test.ts:261`](../../test/unit/write.test.ts#L261) replays a held write's idempotent retry without bumping access_requests again | Tests check one attempt and an idempotent retry; no test makes repeated separate attempts. |

## RP: Replication and offline work

Criteria: [PRD-replication-v6](../prd/components/PRD-replication-v6.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| RP-AC-1 | Covered | [`sync-conflicts.test.ts:100`](../../test/unit/sync-conflicts.test.ts#L100) the later-HLC side wins as head, the earlier side is kept as a conflict sibling, and ctxd review lists it<br>[`sync-conflicts.test.ts:127`](../../test/unit/sync-conflicts.test.ts#L127) converges to the same outcome regardless of which concurrent event is applied first |  |
| RP-AC-2 | Partial | [`sync-partition-property.test.ts:371`](../../test/unit/sync-partition-property.test.ts#L371) is deterministic across random sequences of operations, random partitions, heals and delivery order | Same gap as KM-AC-1. |
| RP-AC-3 | Covered | [`policy.test.ts:5`](../../test/unit/policy.test.ts#L5) filters replication by scope policy and node role |  |
| RP-AC-4 | Partial | [`sync.test.ts:135`](../../test/conformance/sync.test.ts#L135) a second sync with nothing new applies zero events<br>[`sync-purge.test.ts:116`](../../test/unit/sync-purge.test.ts#L116) is idempotent: the same purge event applied twice is already-known the second time | No test interrupts a transfer. |
| RP-AC-5 | Covered | [`sync-partition-property.test.ts:371`](../../test/unit/sync-partition-property.test.ts#L371) is deterministic across random sequences of operations, random partitions, heals and delivery order |  |
| RP-AC-6 | Partial | [`hybrid-search.test.ts:179`](../../test/unit/hybrid-search.test.ts#L179) degrades a single entry to FTS-only ranking when it has no vector yet, without affecting others | No test syncs vectors into a non-computing node. |

## SK: Skills

Criteria: [PRD-skills-v3](../prd/components/PRD-skills-v3.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| SK-AC-1 | Covered | [`skills.test.ts:63`](../../test/unit/skills.test.ts#L63) formats catalog lines and respects the budget<br>[`skills.test.ts:169`](../../test/unit/skills.test.ts#L169) writes a new skill into the client's folder and records it in skill_syncs<br>[`skills.test.ts:183`](../../test/unit/skills.test.ts#L183) writes into codex's folder too (W5.5: ~/.agents/skills, confirmed from source) |  |
| SK-AC-2 | Partial | [`access.test.ts:114`](../../test/unit/access.test.ts#L114) includes the profile of each pool that grants the session scope | Not asserted for skills specifically. |
| SK-AC-3 | Partial | [`tools-read.test.ts:134`](../../test/unit/tools-read.test.ts#L134) excludes a proposed agent decision by default and includes it with include_proposed | Proposed entries are left out of search by default; no test covers proposed skills in get, lookup, listings, catalogs or sync. |
| SK-AC-4 | Covered | [`skills.test.ts:237`](../../test/unit/skills.test.ts#L237) removes a synced file for a skill that is no longer active, and its folder if now empty |  |

## TS: Trust and safety

Criteria: [PRD-trust-safety-v5](../prd/components/PRD-trust-safety-v5.md).

| ID | Status | Verified by | Note |
|---|---|---|---|
| TS-AC-1 | Covered | [`redact.test.ts:29`](../../test/unit/redact.test.ts#L29) rejects agent writes with secrets and passes clean text<br>[`write.test.ts:200`](../../test/unit/write.test.ts#L200) rejects agent writes that match a secret detector, and records a rejection row |  |
| TS-AC-2 | Partial | [`errors.test.ts:26`](../../test/unit/errors.test.ts#L26) lists allowed values for enum errors and never echoes long input<br>[`write.test.ts:200`](../../test/unit/write.test.ts#L200) rejects agent writes that match a secret detector, and records a rejection row | Logs are not inspected. |
| TS-AC-3 | Covered | [`redact.test.ts:23`](../../test/unit/redact.test.ts#L23) catches a secret split by a zero-width character |  |
| TS-AC-4 | Covered | [`write.test.ts:220`](../../test/unit/write.test.ts#L220) holds a write to a scope outside the client's pools and opens an access request<br>[`claim.test.ts:244`](../../test/unit/claim.test.ts#L244) rejects claim/release below propose access, but allows list at read |  |
| TS-AC-5 | Covered | [`access.test.ts:80`](../../test/unit/access.test.ts#L80) applies pool vendor defaults: local-only beats any grant for cloud agents<br>[`policy.test.ts:12`](../../test/unit/policy.test.ts#L12) hides local-only scopes from cloud vendors |  |
| TS-AC-6 | Covered | [`policy.test.ts:19`](../../test/unit/policy.test.ts#L19) refuses non-loopback listeners<br>[`doctor.test.ts:38`](../../test/unit/doctor.test.ts#L38) fails when a listener binds to a non-loopback address |  |
| TS-AC-7 | Gap | None | Import preflight is tested (`mirror.test.ts:147`); export warnings are not. |
| TS-AC-8 | Covered | [`path-guard.test.ts:16`](../../test/unit/path-guard.test.ts#L16) denies a Read/Edit/Write whose file_path is under the guarded directory<br>[`path-guard.test.ts:83`](../../test/unit/path-guard.test.ts#L83) blocks a PreToolUse call targeting the resolved data directory |  |
| TS-AC-9 | Partial | [`scope.test.ts:89`](../../test/unit/scope.test.ts#L89) honors the environment flag | Same gap as HK-AC-7. |
