# ctxd LLD: Mobile Inbox (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 17 |
| **Implements** | [Mobile inbox](../prd/components/PRD-mobile-inbox-v2.md) (MI-1 to MI-12), FR-22 |
| **Owner** | A (agent-generated) by persona `component-designer`, with 17.4's threat model by `security-reviewer`; human review at Gate 3 for the cloud contract and access paths |
| **Code** | `src/inbox/`, `src/cli/inbox.ts`, `cloud/mobile-inbox-worker/` (a sibling project outside ctxd's build; its HTTP contract is `cloud/mobile-inbox-worker/openapi.yaml`) |
| **Moved from** | Section 17 of the Spec v10 that W1 (M7) wrote before the HLD and LLD split; text unchanged apart from links |
| **Runbook** | [Mobile inbox deployment](../runbooks/mobile-inbox-deploy-v1.md) |

Section numbers are the Spec's own (17.1 to 17.6), so references in code comments and handoffs still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 17. Mobile inbox

Implements [PRD-mobile-inbox-v2](../prd/components/PRD-mobile-inbox-v2.md) (PRD v7 section 12;
FR-22). A minimal cloud buffer so phone chats (claude.ai mobile, ChatGPT, iOS Shortcuts) can
capture short notes into ctxd without anything reaching into the home network: writes land only
in the inbox, never ctxd's own store; the hub empties it over an outbound connection; reads out to
the phone are limited to an explicit, owner-set allowlist of non-sensitive briefs.

**Flags, both off by default:** `mobile_inbox` (pulling; with it off, ctxd makes no network calls
to any mobile inbox and ignores inbox configuration) and `mobile_inbox.publish_briefs` (the
allowlisted reads, parent `mobile_inbox`).

### 17.1 Transport abstraction

`InboxTransport` (`src/inbox/types.ts`) is provider-neutral: `pull(limit)` returns a page of
`{inboxEntryId, raw}` items plus a `more` flag; `ack(ids)` deletes acknowledged entries from the
buffer; `status()` reports a pending count. `inboxEntryId` is always the *transport's own* key for
an entry, never trusted from inside `raw`: a malicious or buggy client could omit or spoof an id
in the payload itself, and both idempotent apply and `ack` key on this id, so its source must be
the transport, not the untrusted content. Three implementations: a fake, in-memory transport for
tests; a local-directory transport (one JSON file per entry, named by id) for offline development;
and a Cloudflare adapter (17.4) for the real deployment. A fourth, optional interface,
`BriefPublishTransport`, adds `publishBriefs` for 17.5.

### 17.2 Hub pull engine

`runInboxPull` (`src/inbox/pull.ts`) loops pulling pages until `more` is false. Each item is
handled through the **existing single write path** (6, [LLD: Write path](LLD-write-path-v1.md)), not a parallel one:

1. **Schema validation.** The payload is parsed against the entry schema (`scope`, `kind`,
   `title`, `body`, optional `tags` and `clientRef`, `capturedAt`). A failure is rejected.
2. **Size bounds (MI-5).** 16 KB body, 32 KB total payload, checked in bytes (not the schema's own
   UTF-16 character counts, since a secondary, byte-exact check matters for untrusted input). A
   failure is rejected.
3. **Hard exclusion (MI-7).** A sealed pool's scopes are excluded by construction: they live only
   inside the pool's own encrypted file, never in the main database this check queries. `home`
   replication and `local-only` vendor policy scopes are rejected outright here, not held: this is
   a stricter boundary than the generic access-control hold every other out-of-grant scope gets
   (4 below), because these categories must never even generate a reviewable holding-scope entry
   from an inbox source.
4. **The write itself.** Calls the existing `writeEntry` (section 6) with `clientId` set to the
   restricted `mobile-inbox` client, `request_id` derived deterministically from the transport's
   `inboxEntryId` (never from payload content), and provenance (17.3) carried as tags. Redaction,
   access evaluation and the forced-`proposed`-or-held outcome all happen exactly as they would
   for any other client at `propose` level (MI-6): a scope the client has no grant for holds in
   `_hold.mobile-inbox` with a reviewable access request, exactly like any other client's
   out-of-grant write, rather than being silently dropped or silently written somewhere else.
5. **Ack.** Every item that reached a terminal outcome (applied, held, or hard-rejected at steps
   1 to 3) is acked, even the rejections: a malformed or excluded entry is handled, not retried
   forever. An item that raised an unexpected error (an operational fault, not a verdict on the
   entry) is *not* acked, so the next pull retries it.

**At-least-once delivery, idempotent apply, crash recovery (MI-3, MI-4).** `writeEntry`'s own
idempotency (client id plus `request_id`) makes re-applying an already-applied `inboxEntryId` a
no-op rather than a duplicate, which is also what delivers the crash-recovery property for free:
acking happens strictly after the write's transaction committed, so a crash in that gap just means
the entry is still in the buffer and the next pull re-applies it as a replay. Covered by a
fast-check property (duplicate and reordered delivery across any number of batches converges on
exactly one entry per distinct id) and a dedicated crash-recovery test.

### 17.3 Provenance

Provenance (MI-8, MI-AC-7) is stored in `entries.origin` (schema version 23, W7): canonical JSON
`{source: "mobile-inbox", captured_at, client_ref?}`, set through `WriteContext.origin` and never
from the entry's own payload, so a capture cannot claim where it came from. The entry's declared
tags pass through untouched, and `created_by` separately attributes it to the `mobile-inbox`
client through the ordinary provenance framing (10.1). `ctxd show` prints the origin line.

Until that column existed, these same facts were squeezed into `tags`
(`origin:mobile-inbox`, `captured:<capturedAt>`, `ref:<clientRef>`), which polluted the entry's
own tags and made provenance compete with them for the ten tag slots. W7's plan listed the column
as the fix, and the owner approved it; see [LLD: Data model](LLD-data-model-v1.md) 4.

### 17.4 Cloud adapter

A Cloudflare Worker (`cloud/mobile-inbox-worker/`, a sibling project outside ctxd's own build) is
the recommended cloud host: a serverless edge worker with D1 storage, zero inbound exposure, zero
idle cost, and reachable by ChatGPT Actions, iOS Shortcuts and plain HTTP clients. Deploying it,
minting tokens and connecting phone apps are owner steps (ADR 0003: nothing here changes who may
bind a listener).

- `POST /v1/inbox/entries`: a write-only client token appends one entry. Enforces the same 16/32
  KB bounds as a second, edge-side check, a 10 requests/minute per-token rate limit, and a 500-row
  queue depth cap, returning 429 past either.
- `GET /v1/inbox/pull` and `POST /v1/inbox/ack`: a separate, pull-and-delete-only hub token. A
  client token cannot call these; a hub token cannot call `POST /v1/inbox/entries`.
- `GET /v1/inbox/status`: hub token; pending count.
- `POST /v1/inbox/briefs` (hub token) and `GET /v1/inbox/briefs` (client token): 17.5.

**Threat model:** a stolen client token can only append entries, never read the queue or ctxd's
own state, and everything it appends still lands `proposed` and quarantined (17.2 step 4). A
stolen hub token could read or delete queued entries, but not read ctxd's own store; it is stored
in the macOS Keychain (`ctxd inbox set-token`), never in a file or environment variable (MI-10).
Captured text is adversarial input by construction (prompt injection): it is proposed, quarantined
and excluded from automated execution, the same handling every other untrusted write gets.
Flooding is bounded by the rate limit and queue cap above. Replay (a duplicate pull of an already
applied entry) is exactly 17.2's idempotency property.

### 17.5 Allowlisted brief publishing

`runPublishBriefs` (`src/inbox/publishBriefs.ts`), gated behind `mobile_inbox.publish_briefs`,
pushes a `micro` `context_brief` (11.1, used exactly as a normal brief call would produce it) for
each scope in the owner's `[inbox] publish_scopes` allowlist (empty by default; nothing publishes
until the owner opts a scope in). The same hard exclusion as 17.2 step 3 applies in this
direction too, independent of the allowlist's own contents: "sealed pools never touch the inbox,
in either direction; local-only and home scopes are never published," so a misconfigured
allowlist entry is skipped, not published.

### 17.6 CLI and status

`ctxd inbox pull` runs the pull engine (17.2) and then brief publishing (17.5) if enabled;
`ctxd inbox status` reports the transport's pending count; `ctxd inbox set-token <token>` stores
the Cloudflare hub token in the Keychain. `ctxd status` and `ctxd statusline` report an inbox
pending count that is a real number for the local transport (a fast directory read) and `null`
for the Cloudflare transport, matching the same "report untracked rather than fabricate"
convention `unsynced` already uses (12, this section's own `inboxPending` would otherwise need a
network call that violates `statusline`'s latency budget).

`ctxd inbox schedule install|uninstall|status` manages a launchd agent that runs `ctxd inbox
pull` every `[inbox] schedule_minutes`, so capture works unattended; pulling is deliberately not
part of `ctxd server`'s own scheduled loop. It writes
`~/Library/LaunchAgents/dev.ctxd.inbox-pull.plist` with `StartInterval` (seconds), never
`RunAtLoad` or `KeepAlive` (those belong to the long-running server agent, 12: on an interval job
they would mean "run now, then restart forever"), lints it with `plutil` and loads it with
`launchctl`, reusing `src/cli/service.ts`'s own plist lint. The installed job inherits whichever
`--config` and `--data-dir` the installing invocation was given, so a scratch instance schedules
itself rather than the default one. Because `ctxd inbox pull` exits cleanly without a network call
when `mobile_inbox` is off, a loaded job on a machine with the flag off does nothing, so the
schedule is safe to install before the flag is turned on. Changing the cadence means reinstalling,
since launchd reads the interval from the plist.

This is the same shape as `ctxd backup schedule` (W4, [LLD: Operations](LLD-operations-v1.md) 12),
differing only in what it launches and in `StartInterval` versus that one's
`StartCalendarInterval`. The two are deliberately near-identical so they can collapse into one
plist helper; that extraction is listed, unbuilt, in [W7's plan](../build/W7-plan-v1.md).

**Configuration** (`[inbox]` in `config.toml`): `transport` (`local` or `cloudflare`), `dir` (for
`local`), `endpoint` (for `cloudflare`), `pull_limit` (default 50), `publish_scopes` (default
`[]`), `schedule_minutes` (default 15, valid 1 to 1440).
