# ctxd Component PRD: Mobile Inbox (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Parent** | [ctxd PRD v7](../PRD-v7.md) |
| **Siblings** | [Feature flags](PRD-feature-flags-v1.md), [Persona pools and access](PRD-pools-access-v2.md), [Trust and safety](PRD-trust-safety-v4.md), [Replication](PRD-replication-v5.md), [Context hygiene](PRD-context-hygiene-v1.md), [Knowledge model](PRD-knowledge-model-v3.md) |
| **Spec** | Spec v9 (implemented in M7; to be integrated into Spec v10) |
| **Parent requirements elaborated** | FR-22; NFR-1; NFR-2; NFR-11 |

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
