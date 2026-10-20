# Completion kickoff: finish ctxd (v1)

Instructions for every agent and person working on the rest of ctxd. Read this whole file, then AGENTS.md, the parent [PRD v7](../prd/PRD-v7.md), the latest component PRDs and the latest spec (Spec v9), before doing anything else.

- **Approval.** The owner approved this plan on 2026-10-20. It covers everything left after M6 and M7 slice 1: the rest of M7, the known gaps from the M2 to M6 handoffs, the unmeasured M5 exit criterion, and the owner's real-machine steps.
- **State at the start.** `main` is at `5b4063f` (M6 merged as #52, M7 slice 1 as #53). Typecheck passes; 733 of 735 tests pass on Linux, and the two failures are the macOS-only `plutil` checks in `test/unit/service.test.ts`.
- **Who builds.** Any coding agent (Claude Code, Codex, Gemini) or a person. Workstreams are independent enough to give to different agents; section 2 says which can run in parallel.

## 0. How this run works

- **One workstream per branch**, named `done/w<n>-<slug>` (for example `done/w3-sync-watermarks`), branched from the latest `main`. One commit per slice, message starting `W<n> slice <k>:`. One PR per workstream into `main` when its exit criteria pass. **Merging stays the owner's step.**
- **Definition of done per slice.** `npm run typecheck` and `npm test` pass; you have reviewed your own diff for simplicity and correctness; new behavior has tests. Claude Code also runs the AGENTS.md skills (`/run`, `/simplify`, `/verify`, `/code-review`). Other agents do the equivalent by hand and say so in the handoff.
- **Feature flags.** Every new optional behavior is registered in `src/config/flags.ts` with the default this file gives. Risky behavior ships off.
- **Schema changes** bump `SCHEMA_VERSION` with a migration and a test that opens a database from the previous version. If two workstreams both change the schema, the second to merge renumbers.
- **Docs.** All spec changes from this run collect into **Spec v10** (M7 slice 8 writes it; other workstreams add their sections to it, or to a draft `docs/spec/SPEC-v10-draft.md` that slice 8 folds in). Update a component PRD with a new numbered version only when product behavior changes. Never edit a past version. Prose has no em dashes, en dashes or double hyphens.
- **Handoffs.** Each workstream ends with `docs/build/W<n>-handoff-v1.md`: what shipped, how it was verified, what was not done and why, and any owner steps.
- **Stop only for these**, and when you hit one, write it into the workstream handoff and keep going with every slice that does not depend on it:
  - anything that would touch the owner's real `~/.claude`, `~/.codex`, `~/.config/ctxd`, real ctxd data, real launchd jobs, real Tailscale configuration, real cloud accounts or real tokens;
  - anything that needs the owner's hardware or identity: a second Mac, Touch ID, a code-signing identity, a cloud or developer account;
  - anything irreversible;
  - a product decision that contradicts PRD v7, or one listed in section 4 as the owner's.
- **Never** put real project, scope or pool names in Git (AGENTS.md). Use invented examples.

## 1. Workstreams

### W1. Finish M7, the mobile inbox

Follow [M7-plan-v1.md](M7-plan-v1.md) slices 2 to 8 and the [M7 kickoff](M7-kickoff-v1.md) constraints exactly; they are not repeated here. In short: transport interface with fake and local-directory transports (slice 2), hub pull with validation, redaction, access evaluation and quarantined `proposed` apply (slice 3), delivery and crash property tests (slice 4), the Cloudflare Worker adapter, D1 migrations, wrangler config and OpenAPI spec (slice 5), allowlisted brief publishing behind `mobile_inbox.publish_briefs` (slice 6), `ctxd inbox pull` and `ctxd inbox status` plus status and statusline counts (slice 7), Spec v10, the owner's deploy runbook and the handoff (slice 8).

- **Flags:** `mobile_inbox` and `mobile_inbox.publish_briefs`, both off (already registered).
- **Exit:** the M7 kickoff's section 7. Deploying the Worker and creating tokens are owner steps.

### W2. Sealed pool key transfer to a new node

M6 refuses to enroll a second node into sealed pools because no authenticated key transfer exists. Build it, so the Mac Studio can join.

- **Slice 1, design.** Add the design to the Spec v10 draft: how a sealed pool key travels to an enrolled node without ever existing in plaintext outside the key helper or the test key provider. It must cover:
  - the recipient's encryption key, bound to its already enrolled signing identity;
  - the owner's explicit approval on the source node;
  - a short confirmation code shown on both nodes;
  - replay protection;
  - what revoking a node does (at minimum: no new keys; state whether existing pools are re-keyed).

  Stop and ask the owner only if the design must contradict Spec 10.6.
- **Slices 2 and up, build** against the test key provider: wrap, transfer over the existing sync channel, unwrap, unlock; refusal paths (no approval, wrong code, revoked or unknown node, replay); purge and backup behavior unchanged.
- **Flag:** `sealed_pools.key_transfer`, off.
- **Exit:** two local servers. The second unlocks a sealed pool only after an approved transfer, and every refusal path is tested. The Touch ID check on real hardware is an owner step.

### W3. Sync observability

`ctxd doctor` cannot report each peer's last sync age, and `ctxd statusline` cannot count unsynced events, because sync stores no timestamps or served watermark.

- **Build:**
  - record, per peer, when it last pulled successfully and the highest sequence served to it (a column on `sync_state` or a new table, with a migration);
  - report last sync age in `ctxd doctor`, with a warning past a threshold (default 24 hours, configurable);
  - report unsynced counts in `ctxd statusline` and `ctxd status`.
- **Tests:** the existing convergence property tests still pass; new tests cover the watermark after partitions, restarts and purge.
- **No flag:** it is reporting only, under the existing `sync` flag.
- **Exit:** both numbers are real, never guessed, in a two-node test.

### W4. Scheduled backups

`ctxd backup` works but nothing runs it unattended.

- **Build:**
  - `ctxd backup schedule install|uninstall|status`, which writes a launchd agent with `StartCalendarInterval` running `ctxd backup` (time from `[backup] schedule`, default 03:15), reusing the existing service code and plist lint;
  - tests against a temporary LaunchAgents directory;
  - doctor reporting the age of the newest backup, with a warning past 36 hours.
- **Flag:** none new; respects `backups`.
- **Exit:** install, status and uninstall round trip in tests. Installing it for real is the owner's step.

### W5. Correctness gaps from the handoffs

One slice each:

1. **Approval timestamps.** Set `entries.approved_hlc` and `approved_by` when an entry is approved (review path and any auto-approval), and switch the weekly digest's "decisions made" section to use them. Test both.
2. **Crash sweep release.** Record the session's working directory when the session starts, so the crash sweep can run the same mechanical release and journal entry SessionEnd runs (clean tree and commit checks) for a session that crashed. Gate it under `claims.mechanical_release`. Spec the change.
3. **List mode ordering.** `query: "*"` lists strictly by time, as the spec says, whatever the `importance` flag; relevance multipliers apply only to scored search. Test both flag states.
4. **Automatic skill sync.** When `skills.native_sync` is on, a change to a synced skill schedules a sync through the detached worker, never inside the write path or a hook's deadline. Test the trigger and the off state.
5. **Codex skills folder.** Confirm Codex's user skills folder from Codex's own documentation for the minimum supported version (PRD Q10). If you can confirm it, enable Codex in native skill sync and import. If you cannot, keep reporting "not yet confirmed" and say why in the handoff.

**Accepted limitation, no work:** PreCompact cannot record a phase or last request summary, because neither client's PreCompact payload carries one. Note it once in Spec v10.

**Exit:** each slice has tests; the M2, M4 and M5 handoff items above are closed or marked accepted in the W5 handoff.

### W6. Search quality benchmark

M5's exit criterion, "hybrid search measurably better on a test set", was never measured.

- **Build:**
  - an invented corpus of at least 200 entries across several invented scopes and kinds, with at least 60 labeled queries (keyword, paraphrase, and mixed), in `test/fixtures/search-bench/`;
  - precomputed embeddings from the pinned model (`Xenova/all-MiniLM-L6-v2` at the pinned commit), so the benchmark runs offline;
  - `npm run bench:search` reporting MRR@10, nDCG@10 and recall@10 for keyword-only and hybrid search;
  - a CI check that fails if hybrid drops below its recorded baseline by more than a set margin.
- **Exit:** results written to `docs/build/W6-handoff-v1.md`, stating whether hybrid beats keyword-only on paraphrase queries. If it does not, say so and propose tuning; do not tune the test set to the result.

### W7. New features (after W1 to W6, plan first)

Write a short plan for each and stop for the owner's approval before building:

1. **Agent team memory.** The owner's orchestrator (a separate repository) writes each run's outcome, review findings and lessons into ctxd as `proposed` entries in one invented-name scope, so every agent sees what the team learned. ctxd's side: confirm the write path, access grant and kinds needed; the orchestrator side is its own kickoff.
2. Anything else found while doing W1 to W6, listed with a reason rather than built.

## 2. Order and parallelism

| Order | Workstream | Can run in parallel with | Notes |
|---|---|---|---|
| 1 | W5 | W6 | Small, independent fixes; W5.2 adds a column |
| 2 | W3 | W6 | Changes the sync schema; merge before W2 |
| 3 | W4 | W1, W6 | Touches backup and service code only |
| 4 | W6 | W1, W3, W4, W5 | Test fixtures and a script; no runtime changes |
| 5 | W2 | W1 | Builds on W3's sync state |
| 6 | W1 | W2, W4, W6 | Largest; M7 slice 8 writes Spec v10 last |
| 7 | W7 | none | Plans only until approved |

## 3. The owner's steps (in this order)

1. **Security first.** Confirm with GitHub Support that the orphaned commits from the repository's early history (found when it was made public) have been purged. Until confirmed, assume those commit hashes are still reachable.
2. Install the hooks for real (`ctxd install-hooks`), then the launchd service (`ctxd service install`) and `tailscale serve` per `deploy/tailscale.md`. Never Funnel.
3. Set a real `[backup] age_recipient`, run `ctxd backup` by hand once, then install the schedule from W4.
4. Run `ctxd model fetch` on the daily-driver Mac, turn on `semantic_search.compute` there and `semantic_search` where wanted, and confirm search works on the Intel Air hub (x64 was only checked from package metadata).
5. Build, sign and test `ctxd-keyhelper` with Touch ID ([ctxd-keyhelper-build-v1.md](ctxd-keyhelper-build-v1.md)).
6. Rehearse [M6-hub-migration-runbook-v1.md](M6-hub-migration-runbook-v1.md). Move the hub to the Mac Studio when it arrives, and test W2's key transfer on it.
7. Deploy the M7 Worker from W1's runbook, create the inbox tokens, connect the phone apps, then turn on `mobile_inbox`.
8. Run everything unattended for two weeks (M4's exit criterion) and note what broke.

## 4. The owner's decisions

| # | Decision | Needed by | Default if not decided |
|---|---|---|---|
| D1 | Cloud host for the inbox (M7 plan recommends Cloudflare Worker with D1) | W1 slice 5 | Build the Cloudflare adapter; deploy waits |
| D2 | Which scopes may publish briefs to the phone (`mobile_inbox.publish_briefs` allowlist) | W1 slice 6 | None; the flag stays off |
| D3 | Whether revoking a node re-keys its sealed pools | W2 slice 1 | No re-key; revoked nodes get no new keys |
| D4 | `backups` and `backups.copy` default mismatch (M4 handoff) | W4 | Unchanged |
| D5 | PRD Q3: which scopes are `home`-only and which `local-only` | Owner step 2 | Everything `home` |
| D6 | PRD Q4: auto-accept confirmed decisions in some scopes | Any time | Always review |
| D7 | PRD Q6, Q8: Beads alongside ctxd; coordinate-agents integration | W7 | Neither |
| D8 | PRD Q7, Q9: nudge thresholds and claim lease length after two weeks of use | Owner step 8 | Current defaults |
| D9 | PRD Q10: minimum supported client versions | W5 slice 5 | Versions already pinned in the spec |

## 5. ctxd is complete when

- W1 to W6 are merged, each with its handoff, and Spec v10 is written.
- The full suite passes on macOS, including the `plutil` checks, and the search benchmark passes in CI.
- The owner's steps 1 to 8 are done, the decisions in section 4 are made or explicitly deferred, and PRD v8 records the result (M7 delivered, open questions resolved, remaining non-goals restated).

## 6. Tracking

Keep this table current in each workstream's PR description; the owner copies it into the next handoff.

| Workstream | Branch | Status | PR | Handoff |
|---|---|---|---|---|
| W1 M7 inbox | done/w1-mobile-inbox | ready for merge | | docs/build/W1-handoff-v1.md |
| W2 Sealed key transfer | | not started | | |
| W3 Sync observability | | not started | | |
| W4 Scheduled backups | | not started | | |
| W5 Correctness gaps | | not started | | |
| W6 Search benchmark | | not started | | |
| W7 New features | | plan only | | |
