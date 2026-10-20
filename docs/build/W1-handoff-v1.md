# W1 handoff v1

## Commits

- `2b34711` `W1 slice 2: core inbox types and transport abstraction`
- `362cf6d` `W1 slice 3: hub pull engine, sanitization, and quarantined apply`
- `4aa529e` `W1 slice 4: delivery property tests and crash recovery`
- `3f799f9` `W1 slice 5: Cloudflare adapter and deployment artifacts`
- `8728615` `W1 slice 6: allowlisted brief publishing`
- `d50120e` `W1 slice 7: ctxd inbox pull/status, and inbox counts in ctxd status`
- this handoff (slice 8, with the Spec v10 and runbook commits)

Branch `done/w1-mobile-inbox`, branched from `main` after W2 and W5 had merged (#59, #55). This
is M7 slices 2 to 8; M7 slice 1 (plan, component PRD, flags) was already merged earlier as #53.
Nothing was pushed and no pull request opened yet; that is the owner's step per the kickoff plan.

## Delivered

Follows [M7-plan-v1.md](M7-plan-v1.md) and the [M7 kickoff](M7-kickoff-v1.md)'s constraints
exactly, using the completion kickoff's default decisions (D1: build the Cloudflare adapter,
deploy waits; D2: the `publish_scopes` allowlist stays empty).

**The transport abstraction** (`src/inbox/types.ts`, MI-1, MI-2): `InboxTransport`
(`pull`/`ack`/`status`) and the optional `BriefPublishTransport`. An entry's identity for `ack`
and idempotency is always the *transport's own* id, never trusted from inside the payload — a
deliberate correction made mid-slice-2, before slice 3 built on top of it, once it was clear a
malicious or buggy client could otherwise spoof or omit it. Three implementations:
`FakeInboxTransport` (in-memory, tests), `LocalDirInboxTransport` (one JSON file per entry,
offline development), `CloudflareInboxTransport` (the real adapter, slice 5).

**The hub pull engine** (`src/inbox/pull.ts`, MI-3 to MI-7) reuses the existing single write path
(`writeEntry`) rather than a parallel one: redaction, access evaluation and the forced-`proposed`-
or-held quarantine all come for free. A grant-less scope holds for review (MI-6), exactly like any
other client's out-of-grant write; a sealed, `home`-replication or `local-only` scope is rejected
outright instead (MI-7) — sealed pools are excluded by construction (their scopes never appear in
the query this runs against), `home`/`local-only` explicitly. Oversized payloads and schema-
invalid entries are rejected and still acked, so a bad entry can't jam the queue. Provenance (MI-8)
is carried as tags, since `entries` has no generic metadata column.

**Delivery and crash recovery** (MI-3, MI-4): a fast-check property covering duplicate and
reordered delivery across any number of pull batches (materialized state always ends with exactly
one entry per distinct id), plus a dedicated test simulating the hub dying between a committed
apply and its ack. Both fall out of `writeEntry`'s own idempotency (client id + a request id
derived from the transport's id) rather than new machinery.

**The Cloudflare adapter and deployment artifacts** (slice 5): `CloudflareInboxTransport` (the
hub-side HTTP client) plus `cloud/mobile-inbox-worker/` — the Worker itself, a D1 migration,
`wrangler.toml`, and an OpenAPI 3.1 spec for the client-facing capture endpoint. Write-only client
tokens, a separate pull/ack-only hub token, MI-5's size bounds re-checked at the edge, a 10/min
rate limit and a 500-entry queue cap, matching M7-plan-v1's threat model. A sibling project outside
ctxd's own build (root `tsconfig.json`'s `include` is `src/**/*.ts` only).

**Allowlisted brief publishing** (slice 6, MI-9): `runPublishBriefs` pushes a `micro` brief per
scope in `config.inbox.publish_scopes` (empty by default, D2), reusing `context_brief` assembly
as-is. The sealed/local-only/home exclusion is shared code (`src/inbox/scopeExclusion.ts`) with
the apply direction, so a misconfigured allowlist entry is skipped rather than published.

**CLI and status** (slice 7, MI-11): `ctxd inbox pull`, `ctxd inbox status`, `ctxd inbox
set-token` (Keychain, MI-10). `ctxd status`/`statusline` gained an `inboxPending` count: real for
the local transport, `null` for Cloudflare (a network call would violate `statusline`'s latency
budget, the same convention `unsynced` already uses).

**Spec, runbook** (slice 8): [Spec v10](../spec/SPEC-v10.md) section 17, written from
[Spec v9](../spec/SPEC-v9.md) plus W2's and W5's merged content (folded in from
[SPEC-v10-draft.md](../spec/SPEC-v10-draft.md), left in place for W3/W4/W6 to still append to
before their own merge) and this workstream's own section. [M7-deploy-runbook-v1.md](M7-deploy-runbook-v1.md)
is the step-by-step owner walkthrough: deploy the Worker, mint tokens, connect phone apps, turn
the flag on.

## Verification

`npm run typecheck` and `npm test`: 811 of 811 tests passing across 76 files (20 new tests added
this workstream, across `test/unit/inbox-transport.test.ts`, `inbox-pull.test.ts`,
`inbox-delivery-property.test.ts`, `inbox-crash-recovery.test.ts`, `inbox-cloudflare-
transport.test.ts`, `inbox-publish-briefs.test.ts`, `cli-inbox.test.ts`, plus additions to the
existing `status.test.ts`).

Also run live, against a scratch `ctxd init` instance (not the owner's real data): created the
`mobile-inbox` client, granted it `propose` on a scope, wrote a captured entry through the local
transport, ran `ctxd inbox pull` (applied, 0 held, 0 rejected), confirmed `ctxd inbox status`
reports `pending=0` after the pull, and confirmed the entry appears in `ctxd review` as `proposed`
attributed to `mobile-inbox`.

## What was not done and why

Nothing from M7's slice list was skipped. Explicitly deferred, by the kickoff's own stop rules or
this slice's own scope:

- **Deploying the Worker, minting real tokens, connecting real phone apps, and turning
  `mobile_inbox` on for real** are the owner's steps (completion-kickoff-v1.md section 0's stop
  rule: real cloud accounts and real tokens). [M7-deploy-runbook-v1.md](M7-deploy-runbook-v1.md)
  covers all of it.
- **Scheduling `ctxd inbox pull`** (so capture works unattended, not only when run by hand) was not
  built: M7's own slice 7 asked only for the CLI subcommands, not a `ctxd server`-loop scheduler or
  a `ctxd inbox pull schedule` installer analogous to W4's. The runbook's section 7 notes this as
  the owner's step (a `launchd`/cron entry) and names the natural next slice if it becomes the
  common case.
- **Folding W3/W4/W6's own Spec v10 additions, if any, once those PRs merge** is not done here,
  since they were still open when this was written and their own scope (reporting, scheduling, a
  benchmark) does not obviously need spec text. Noted in Spec v10's own "Changes in v10" section
  as the next edit to make if one turns out to be needed.

## Owner steps

1. Follow [M7-deploy-runbook-v1.md](M7-deploy-runbook-v1.md) to deploy the Worker, mint tokens,
   connect phone apps, and turn `mobile_inbox` on.
2. Schedule `ctxd inbox pull` for unattended capture (runbook section 7).
3. Decide D2 for real (which scopes, if any, publish briefs back to the phone) once the capture
   side has been used for a while; the allowlist stays empty until then.
4. Merge this branch (owner's step, per the kickoff plan's section 0).
5. Once W3, W4 and W6 have also merged, confirm whether any of them need their own Spec v10
   section folded in (see "what was not done" above).
