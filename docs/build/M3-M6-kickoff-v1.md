# M3 to M6 kickoff: flags, replication, the hub, search and polish, hardening (v1)

Instructions for the agent building the rest of ctxd. Read this whole file, then AGENTS.md, before doing anything else. The owner has approved M3, M4, M5 and M6, in that order. M7 (the mobile inbox) is not approved.

## 0. How this run works

- **One milestone at a time, without pausing between them.** For each milestone, write its slice plan to `docs/build/M<n>-plan-v1.md` in that milestone's first PR, then build every slice. When a milestone ends, open its integration PR and its handoff, then start the next milestone right away. Do not wait for approval at milestone boundaries; the owner reads the plans and handoffs as you go.
- **Branching and merging.** One branch and one PR per slice, as in M1 and M2. At the end of each milestone, combine its slices into `integration/m<n>`, run the full suite, and open one PR into `main` (the way PR #24 combined M1 and M2). The next milestone branches from that integration branch, so you never wait for a merge. Merging stays the owner's step.
- **Stop only for these**, and when you hit one, write the question into the milestone handoff and keep going with every slice that does not depend on it:
  - anything that would touch the owner's real `~/.claude`, `~/.codex`, `~/.config/ctxd`, real ctxd data, real launchd jobs or real Tailscale configuration;
  - anything that needs the owner's hardware or identity: a second Mac, Touch ID, a code-signing identity, an Apple developer account;
  - anything irreversible;
  - a product decision that contradicts PRD v7.
- **Every new optional behavior gets a feature flag** from [Feature flags v1](../prd/components/PRD-feature-flags-v1.md), with the default that document gives. Risky features ship switched off.
- **Definition of done per slice** is unchanged (AGENTS.md): `/run`, typecheck and tests, `/simplify`, `/verify`, `/code-review`, then a PR with the verification and a short handoff. Track slices with the task list; run `/ctxd-build milestone M<n>` at the start of each milestone.
- **Docs.** Each milestone collects its spec changes into the next numbered spec version at its end (M3 starts with Spec v8). Update a component PRD with a new numbered version only when the product behavior changes. Never edit a past version.

## 1. M3: feature flags, then replication

**First slice: feature flags.** Implement [Feature flags v1](../prd/components/PRD-feature-flags-v1.md) in full, and write Spec v8 (Spec v7 plus a feature-flag section: the `[features]` config table, the registry, the environment variables, live reload, `ctxd features`, and the off path of every flag). Retrofit flags onto everything M1 and M2 built (every `hooks.*` flag, `claims.mechanical_release`, `review.remembered_rules`, `metering`). Add `hooks.prompt_search` as a flag, default off, which also settles the M2 handoff's open question about enabling R7. Tests: every flag's off path is inert, hooks exit 0 with the server down and a flag off, and `tools/list` is identical with every flag off.

**Then replication** (Spec 5, 7.1 to 7.4, 7.6.6 step 3, 10.2; [Replication v4](../prd/components/PRD-replication-v4.md)):

- the sync listener on `127.0.0.1:7412` only, peer tokens, and the pull protocol with per-origin watermarks (`through`), batching and a "pull now" notification;
- the replication policy filter (`all`, `home`, `local`; home and roaming nodes); sealed scopes never replicate in M3;
- apply with per-part conflict policies, siblings, `conflicted` entries and their resolution in `ctxd review`;
- purge propagation, including stripping late arrivals;
- claims across nodes: tentative claims while offline, deterministic tie-break, `lost` claims, and overlaps detected at sync (`origin = 'sync'`);
- review rules, grants and pool changes traveling as `acl` and scope metadata events, closing the M2 handoff's gap where they were written directly;
- sync freshness in brief headers and the stale-sync notice;
- `ctxd node add-peer`, `ctxd node revoke`, `ctxd sync [--peer]`;
- flags `sync` (default off) and `sync.serve`.

**Tests.** Property tests with N in-process nodes, random operations (claims, purges, quarantines and reverts included), random partitions, heals and delivery order: identical state hashes, no lost events, correct watermarks under filtering. Then two real servers on different ports converging end to end.

**Exit.** The partition suite passes; two local servers converge, including after `sync` is switched off for one of them and back on. Write the exact commands for the owner's real check (laptop and hub over `tailscale serve`) into the handoff as a dry run; running them is the owner's step.

## 2. M4: the hub

(Spec 10.2, 12; deploy/.)

- `ctxd service install|uninstall|status`: a launchd agent from `deploy/launchd`, validated with `plutil -lint`. Tests use a temporary folder and a test label; installing the real agent is the owner's step.
- Startup integrity: `quick_check` and the schema version check before listening; refuse to start over a missing or corrupt database when backups or peers exist; point to `ctxd doctor` and `ctxd restore`.
- Backups: nightly `VACUUM INTO`, `age` encryption, 14 kept, optional copy to `copy_to`; `ctxd backup` and `ctxd restore`, with a restore round trip in the tests. Flags `backups` and `backups.copy`, both default off.
- `ctxd doctor` with every check in Spec 12, including disabled feature flags and hook installation per client.
- `ctxd status` and `ctxd statusline` (under 50 ms, local state only); flag `statusline`.
- Detached workers (`ctxd worker <ticket>`, Spec 9.7) and moving SessionEnd's work onto them, closing the M2 handoff's gap.
- `deploy/tailscale.md` brought up to date with exact `tailscale serve` commands (never Funnel), plus a hub checklist: power, restart after power loss, FileVault, phone SSH.

**Exit.** A fresh install on a scratch home folder passes `ctxd doctor`; backup and restore round-trip; the service plist lints and loads under a test label. Owner steps (real service, real `tailscale serve`, the two-week unattended run) go in the handoff.

## 3. M5: search and polish

- **Semantic search:** sqlite-vec with a local embedding model served on localhost (for example through Ollama), blended with full-text search by reciprocal rank fusion (Spec 11.2). Flag `semantic_search`, default off; it falls back to full-text search when the model is not reachable. Decide the model choice (PRD Q5) in the plan, local only.
- **Measured improvement:** build a labeled test set of invented entries and queries, and report recall at 3 and mean reciprocal rank with and without semantic search. The exit criterion is a measurable improvement.
- **Claude Desktop:** per-persona `ctxd stdio` entries and project instructions (Spec 9.6), with the configuration printed as a dry run.
- **Scope rollback** with preview (Spec 7.6.5).
- **Review-by dates and `ctxd tidy`** using importance (Spec 7.6.7, 11.3).
- **Importance ranking** in briefs and search, if not already complete; flag `importance`.
- **Weekly digests** on the digest node (Spec 11.5); flag `digest`.
- **Native skill sync and skills import** (Spec 12.2), tested against temporary skill folders only; flag `skills.native_sync`, default off.

**Exit.** Hybrid search measurably better on the test set; rollback preview matches what it applies; skill sync never touches a folder it did not write.

## 4. M6: hardening and the Mac Studio

- **Signed events:** Ed25519 keys per node, signatures over a payload hash that survives purge (Spec 16, issue 12). Flag `signed_events`, default off; verification of existing signatures continues when it is off.
- **Markdown export** (FR-19), and the **Markdown mirror and import** (Spec 12.1). Flag `mirror`, default off; sealed pools are never mirrored.
- **Sealed pools** (Spec 10.6): the encrypted file, attach and detach, encrypted replication to enrolled nodes only, purge inside the sealed file. Choose the SQLCipher-compatible library in the plan. Build and test everything against a test key provider. The Touch ID key helper needs code signing and the owner's hardware: write the helper and its build steps, and leave signing and the Touch ID check to the owner. Flag `sealed_pools`, default off.
- **Hub migration:** `ctxd node adopt` and the migration runbook (Spec 12).
- **Local model hooks:** optional summaries and lesson suggestions, always written as proposed and labeled as machine-written. Flag `local_model`, default off.

**Exit.** Signed events verify across two local servers, including after a purge; the mirror round-trips edits with revision checks; sealed-pool tests pass with the test key provider. Moving the hub to the Mac Studio and running a real local model are owner steps in the handoff.

## 5. Carry-over from M2 (close where noted)

| Gap from the M2 handoff | Closed in |
|---|---|
| Review rules, grants and pools written directly instead of as events | M3 |
| Conflicted and auto-resolved review items have nothing to show until sync | M3 |
| R7 prompt-time hints have no enable switch | M3, flag `hooks.prompt_search` |
| Detached workers do not exist; SessionEnd runs synchronously | M4 |
| Drift from checkpoint files needs the data directory in the write context | M4, with the worker plumbing |
| The crash sweep cannot check a crashed session's working tree | Documented as a limit in Spec v8; no fix planned |
| PreCompact cannot record a phase or request summary | Documented as a limit in Spec v8; no fix planned |
| `ctxd install-hooks` writes nothing yet (dry run only) | Already being added separately by the owner's setup run; if not merged by M4, add it in M4 |
