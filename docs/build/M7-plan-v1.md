# M7 build plan v1: mobile inbox

This plan covers M7 only, as defined by `docs/build/M7-kickoff-v1.md`, PRD v7 section 12, and FR-22.
Work stays on branch `m7/gemini`. Each slice ends with `npm run typecheck`, `npm test`, a live check
against scratch configuration and data directories, a simplification pass, a review of the slice
diff, and one commit whose subject begins `M7 slice N:`. Nothing is pushed and no pull request is
opened.

## 1. Source of truth

Implementation follows PRD v7, component PRDs (including the new `PRD-mobile-inbox-v1.md`), and Spec v9.
At milestone conclusion, Spec v10 will be produced by collecting all M7 additions and updates.
Past numbered documents remain unchanged.

## 2. Recommendation and tradeoffs for the cloud side

Capturing notes from mobile assistants requires a public ingestion point that phone apps can reach,
while strictly maintaining zero inbound network access to the home environment.

### Options evaluated

1. **Cloudflare Worker with D1 or KV (Recommended):**
   - *Architecture:* Serverless edge worker exposing HTTPS endpoints backed by Cloudflare D1 (serverless SQLite) or KV storage.
   - *Inbound path home:* None. ctxd connects purely outbound to pull and delete entries.
   - *Write-only exposure:* Clients use distinct append-only bearer tokens. They cannot read queued entries, browse history, or access ctxd state.
   - *Cost:* Free tier easily accommodates personal mobile note volume (up to 100,000 requests per day at zero dollar cost).
   - *Client compatibility:* Directly reachable by ChatGPT Actions (via OpenAPI JSON specification), iOS Shortcuts / Share Sheet (simple HTTP POST), and mobile webhooks.

2. **Remote MCP endpoint on a container or serverless host (Fly.io / Deno Deploy):**
   - *Architecture:* Dedicated server exposing MCP tools (such as `inbox_capture`) over HTTP with Server-Sent Events (SSE).
   - *Tradeoffs:* While native to MCP-enabled clients, mobile phone assistants (e.g. standard ChatGPT mobile, iOS Shortcuts) have limited or fragmented native remote MCP support compared to standard HTTP REST actions. Incurring recurring container costs is also unnecessary for low-frequency captures.

3. **Self-hosted VPS or cloud VM:**
   - *Tradeoffs:* Requires server patching, OS maintenance, TLS cert renewals, and baseline hosting costs ($4 to $6 per month) for an idle queue.

### Recommendation

A lightweight Cloudflare Worker with D1 storage is recommended. It provides:
- A REST endpoint `POST /v1/inbox/entries` for ChatGPT Actions and iOS Shortcuts.
- A remote MCP endpoint `POST /mcp` exposing an `inbox_capture` tool for MCP-capable clients.
- An authenticated hub interface `GET /v1/inbox/pull` and `POST /v1/inbox/ack` for the home Mac.
- Zero inbound exposure, zero infrastructure cost, and absolute write-only isolation for client credentials.

## 3. Threat model for the inbox

1. **Stolen client token:**
   - *Risk:* An attacker extracts the mobile client token and posts unwanted or malicious messages to the queue.
   - *Mitigation:* The client credential has write-only append access. It cannot inspect queue contents, read prior notes, or query ctxd. The worker enforces rate limits (e.g. 10 requests per minute per IP) and strict entry payload limits (maximum 32 KB). Furthermore, all ingested items land in ctxd with `proposed` status and are quarantined from execution or automated adoption until reviewed.

2. **Stolen hub token:**
   - *Risk:* An attacker intercepts the hub pull token and reads or deletes queued items.
   - *Mitigation:* Hub credentials reside in the macOS Keychain using ctxd's secret manager, never in git or environment files. Outbound transport requires TLS with verified certificates. Pull intervals keep the cloud buffer drained, so the window of exposure for buffered entries is minimal.

3. **Prompt injection in captured text:**
   - *Risk:* Captured mobile notes contain adversarial instructions designed to deceive reading agents or bypass policy.
   - *Mitigation:* Ingested entries are recorded as untrusted inputs with origin `mobile-inbox` and proposed status. They pass through ctxd secret redaction and access evaluation (Spec 10.5). They cannot modify configuration, change permissions, or execute commands.

4. **Flooding and denial of service:**
   - *Risk:* Rapid submissions attempt to fill cloud storage or overwhelm the local hub during sync.
   - *Mitigation:* The cloud worker enforces a maximum queue depth (500 entries) and rejects additional submissions with HTTP 429 once full. Maximum body text is bounded at 16 KB per entry.

5. **Replay attacks:**
   - *Risk:* A captured entry is pulled multiple times, causing duplicate entries in the event log.
   - *Mitigation:* Every entry carries a client-assigned or content-derived unique `inbox_entry_id`. The hub applies entries idempotently against this identifier. Subsequent pulls of an already applied ID result in zero new events and proceed immediately to deletion.

## 4. Milestone Slices

- **Slice 1: Plan, component PRD, and feature flags**
  - Document the build plan (`docs/build/M7-plan-v1.md`) and component PRD (`docs/prd/components/PRD-mobile-inbox-v1.md`).
  - Register feature flags `mobile_inbox` and `mobile_inbox.publish_briefs` in `src/config/flags.ts` (both defaulted to off).
  - Update flag tests and verify clean baseline.

- **Slice 2: Core inbox types, schema, and transport abstraction**
  - Define `InboxEntry`, `InboxPullRequest`, `InboxAckRequest`, and `InboxTransport` interfaces.
  - Implement the Fake in-memory transport for unit tests.
  - Implement the Local Directory transport for offline development and testing.

- **Slice 3: Hub pull engine, sanitization, and quarantined apply**
  - Implement inbox pull logic with payload size bounds and schema validation.
  - Wire secret redaction and access evaluation for the restricted `mobile-inbox` identity.
  - Commit entries to the local store as `proposed` events under allowlisted scopes.
  - Enforce sealed pool isolation (reject any entry targeting sealed, `local-only`, or `home` scopes).

- **Slice 4: Delivery property tests and crash recovery**
  - Property tests for at-least-once delivery, duplicate handling, and reordered entries.
  - Simulated crash recovery tests verifying entries applied before a crash are acknowledged without duplication upon resume.

- **Slice 5: Cloud adapter and deployment artifacts**
  - Implement the Cloudflare Worker adapter in TypeScript.
  - Write Cloudflare Worker implementation, D1 database migrations, and wrangler configuration.
  - Produce OpenAPI 3.1 specification for ChatGPT Actions and iOS Shortcuts setup.

- **Slice 6: Allowlisted brief publishing**
  - Implement optional brief publishing gated behind `mobile_inbox.publish_briefs`.
  - Filter briefs to ensure sealed, private, and local-only scopes are never published.

- **Slice 7: CLI integration and status reporting**
  - Add `ctxd inbox pull` and `ctxd inbox status` CLI subcommands.
  - Connect inbox status and pending counts into `ctxd status` and statusline.

- **Slice 8: Spec v10, runbook, and milestone handoff**
  - Compile Spec v10 containing all M7 additions.
  - Write step-by-step owner deployment runbook for Cloudflare setup.
  - Write `docs/build/M7-handoff-v1.md` documenting verification results and owner steps.

## 5. Hard constraints and stop rules

- Loopback only: ctxd never opens non-loopback ports or public listeners (ADR 0003).
- Flags default off: with `mobile_inbox` disabled, ctxd performs zero network operations.
- Sealed pools never touch the inbox: sealed scopes cannot be targeted by incoming notes or exported as briefs.
- Stop rules: choosing or provisioning cloud accounts, setting up domain names, deploying live cloud workers, or touching real Keychain secrets are owner steps. Tests use fakes and scratch directories.
