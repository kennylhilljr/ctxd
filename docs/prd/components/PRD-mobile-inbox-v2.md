# ctxd Component PRD: Mobile Inbox (v2)

| | |
|---|---|
| **Status** | Draft v2 |
| **Date** | 2026-10-20 |
| **Supersedes** | [v1](PRD-mobile-inbox-v1.md) |
| **Parent** | [ctxd PRD v8](../PRD-v8.md) |
| **Siblings** | [Feature flags](PRD-feature-flags-v2.md), [Persona pools and access](PRD-pools-access-v3.md), [Trust and safety](PRD-trust-safety-v5.md), [Replication](PRD-replication-v6.md), [Context hygiene](PRD-context-hygiene-v2.md), [Knowledge model](PRD-knowledge-model-v4.md) |
| **Spec** | [Spec v10](../../spec/SPEC-v10.md) (HLD) sections none yet; M7 adds them |
| **Acceptance tests** | [Test plan v1](../../test/test-plan-v1.md), MI section |
| **Parent requirements elaborated** | FR-22; NFR-1; NFR-2; NFR-11 |

## Changes in v2

Earlier changes are listed in [v1](PRD-mobile-inbox-v1.md).

- **Acceptance criteria added.** v1 had none. They are derived from the behavioral requirements in section 4 (MI-1 and MI-2 define the transport interface and adapters, a design matter verified in the LLD M7 will add), written in EARS with IDs (`MI-AC-n`), and listed as not built in the [test plan](../../test/test-plan-v1.md) until M7 implements them.
- **Links.** The header points to PRD v8 and Spec v10; sibling links point to current versions.

## 1. Purpose

When away from the desk, ideas, task captures, and conversation summaries happen on mobile phones through apps such as claude.ai mobile, ChatGPT, or iOS Shortcuts. Capturing these notes directly into ctxd is valuable, but exposing a home Mac to the public internet or binding non-loopback network listeners violates core security principles (ADR 0003, NFR-1).

The mobile inbox provides a secure, minimal cloud buffer where phone clients append short notes. A local ctxd node connects outbound to pull entries, validates and redacts them, records them as proposed events in the event log, and removes them from the cloud buffer once durability is confirmed.

## 2. Architectural Principles and Hard Constraints

- **Outbound pull only.** The ctxd hub connects outbound via HTTPS to the cloud buffer. The home network accepts zero inbound connections, and ctxd never binds listeners to public interfaces (ADR 0003).
- **Buffer, not a mirror.** The cloud inbox holds only ephemeral capture entries awaiting pickup. It is never a replica of ctxd's event log or SQLite database.
- **Write-only exposure for phone clients.** Phone chat apps and mobile shortcuts hold credentials that permit appending entries only. They cannot read entries submitted by other clients, browse ctxd history, or inspect local knowledge.
- **Quarantine on ingest.** All inbox entries arrive with proposed status, labeled with origin `mobile-inbox` and their client identifier. They never bypass human or policy review.
- **Sealed pool isolation.** Sealed pools and scopes designated as `local-only` or `home` are strictly barred from the inbox. They can neither receive inbox captures nor be published as briefs.
- **At-least-once pull with idempotent apply.** Pulling is resilient to network partitions, duplicate delivery, and client retries. Entries are deleted from the cloud buffer only after local persistence commits.
- **Fail safe and offline first.** When network connectivity is absent or flags are disabled, ctxd functions normally with zero network attempts.

## 3. Feature Flags

Two feature flags in `src/config/flags.ts` govern mobile inbox functionality:

| Flag | Default | From | Off means |
|---|---|---|---|
| `mobile_inbox` | off | M7 | ctxd makes no network calls to any mobile inbox and ignores inbox configuration |
| `mobile_inbox.publish_briefs` | off | M7 | No briefs or summaries are published to the cloud inbox (parent: `mobile_inbox`) |

## 4. Requirements

| ID | Requirement | Priority |
|---|---|---|
| MI-1 | **Transport abstraction.** ctxd defines a provider-neutral `InboxTransport` interface with operations to pull pending entries and acknowledge (delete) processed entries. | P0 |
| MI-2 | **Transport adapters.** Support a test Fake transport, a local directory transport for offline development, and an HTTPS Cloudflare Worker adapter. | P0 |
| MI-3 | **At-least-once delivery and idempotency.** The hub pulls entries in batches, applies each entry by its unique `inbox_entry_id`, and acknowledges deletion only after the write transaction commits. Re-applying an existing entry is a no-op. | P0 |
| MI-4 | **Crash recovery.** If the hub process halts after applying an entry but before acknowledging deletion, the next pull re-receives the entry, detects the existing `inbox_entry_id`, and acknowledges deletion safely without duplicate entries. | P0 |
| MI-5 | **Untrusted input sanitization.** Every inbox entry is subjected to strict payload bounds (maximum 32 KB total payload, maximum 16 KB body text), schema validation, and secret redaction before storage. | P0 |
| MI-6 | **Access evaluation and quarantine.** Ingested items are attributed to client identity `mobile-inbox`. They are placed in proposed status and evaluated against scope permissions. Attempts to target unauthorized scopes are redirected to a holding scope. | P0 |
| MI-7 | **Sealed pool exclusion.** Any inbox entry specifying a sealed pool, `local-only`, or `home` scope is rejected and flagged as invalid. | P0 |
| MI-8 | **Provenance metadata.** Materialized entries store origin metadata including mobile client identifier, capture timestamp, and external message reference if provided. | P1 |
| MI-9 | **Optional brief publishing.** When `mobile_inbox.publish_briefs` is enabled, ctxd can push allowlisted, non-sensitive scope briefs to the cloud worker so mobile assistants have minimal project context. | P2 |
| MI-10 | **Keychain credentials.** Hub API tokens and encryption keys are stored securely using macOS Keychain access; no secrets exist in repository files or version control. | P0 |
| MI-11 | **CLI commands.** Implement `ctxd inbox pull` to trigger manual ingest, and `ctxd inbox status` to inspect inbox sync health, pending counts, and transport configuration. | P1 |
| MI-12 | **Safe off switch.** With `mobile_inbox` turned off, all inbox commands exit cleanly or report disabled status, background timers make zero requests, and hooks exit 0. | P0 |

## 5. Security and Threat Model

- **Stolen client token:** A phone credential compromise allows appending text to the inbox queue. The attacker cannot read ctxd contents or existing queue items. Mitigated by rate limiting, strict entry size limits, payload validation, and quarantine as proposed status.
- **Stolen hub token:** An attacker gaining the hub token could read pending inbox notes or acknowledge queue entries prematurely. Mitigated by storing hub tokens in macOS Keychain, requiring TLS with authenticated host headers, and minimizing dwell time in the buffer.
- **Prompt injection in captured content:** Captured text may contain malicious system prompts or jailbreak attempts. Mitigated because all ingested context enters as untrusted proposed text, excluded from automated execution, and subject to review.
- **Denial of service and queue flooding:** The cloud worker enforces payload limits (32 KB max), rate limits per client, and a queue depth cap (maximum 500 entries) before returning HTTP 429.

## 6. Open Questions and Future Considerations

- **Q1:** Should mobile clients specify target scopes directly, or should all mobile notes default to a single staging scope such as `inbox` or `notes`? (Recommended: allow specifying an intended scope, but validate against pool permissions and fall back to `notes` or a holding scope).
- **Q2:** Is brief publishing required for initial mobile capture? (No, brief publishing is separated under `mobile_inbox.publish_briefs` and defaulted to off).

## 7. Acceptance criteria

> Owner: A (agent-generated) by persona `product-writer`, derived from the requirements above; pending the owner's approval at Gate 1. Verification status per criterion: [test plan](../../test/test-plan-v1.md).

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| MI-AC-1 | Event-driven | When the hub pulls an inbox batch, ctxd shall apply each entry once by `inbox_entry_id` and acknowledge its deletion only after the write commits. | MI-3 |
| MI-AC-2 | Unwanted behavior | If the hub stops after applying an entry but before acknowledging it, then the next pull shall acknowledge that entry without creating a duplicate. | MI-4 |
| MI-AC-3 | Unwanted behavior | If an inbox entry exceeds 32 KB of payload or 16 KB of body, or fails schema validation, then ctxd shall reject it without storing it. | MI-5 |
| MI-AC-4 | Unwanted behavior | If an inbox entry contains a secret, then ctxd shall redact it before storage. | MI-5 |
| MI-AC-5 | Ubiquitous | ctxd shall store every inbox entry as `proposed`, attributed to the client `mobile-inbox`. | MI-6 |
| MI-AC-6 | Unwanted behavior | If an inbox entry targets a scope the `mobile-inbox` client may not write, then ctxd shall place it in that client's holding scope. | MI-6 |
| MI-AC-7 | Ubiquitous | ctxd shall record each inbox entry's origin: the mobile client identifier, the capture time and any external message reference. | MI-8 |
| MI-AC-8 | Unwanted behavior | If an inbox entry targets a sealed pool, a `local-only` scope or a `home` scope, then ctxd shall reject it as invalid. | MI-7 |
| MI-AC-9 | State-driven | While `mobile_inbox` is off, ctxd shall make no inbox network requests. | MI-12 |
| MI-AC-10 | State-driven | While `mobile_inbox` is off, every `ctxd inbox` command shall exit cleanly and report that the feature is disabled. | MI-11, MI-12 |
| MI-AC-11 | State-driven | While `mobile_inbox` is off, every ctxd hook shall still exit 0. | MI-12 |
| MI-AC-12 | Ubiquitous | ctxd shall keep inbox API tokens and encryption keys only in the macOS Keychain, never in a repository or configuration file. | MI-10 |
