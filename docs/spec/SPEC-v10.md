# ctxd Technical Specification (v10): System High-Level Design

| | |
|---|---|
| **Status** | Draft v10 |
| **Date** | 2026-10-20 |
| **Layer** | L3 high-level design (the whole system). Component detail is in the L4 [LLDs](../lld/) and [contracts](../contracts/) |
| **Owner** | C (co-authored): persona `architect` drafts, the owner decides at Gate 2 |
| **Implements** | [PRD v8](../prd/PRD-v8.md) and its component PRDs (traceability below) |
| **Supersedes** | [Spec v9](SPEC-v9.md) and the working notes formerly in `SPEC-v10-draft.md` |
| **Related** | [ADR 0001](../adr/0001-local-first-replicated-store.md), [ADR 0002](../adr/0002-event-log-sync.md), [ADR 0003](../adr/0003-no-public-endpoint.md), [ADR 0004](../adr/0004-embeddings-replicate.md), [Prior art v4](../research/prior-art-v4.md), [Test plan v1](../test/test-plan-v1.md) |

## Changes in v10

Earlier changes are listed in [Spec v9](SPEC-v9.md), [v8](SPEC-v8.md) and before.

| Change | Where |
|---|---|
| **Split into HLD and LLDs.** This document keeps the system-level design: architecture, stack, file locations, the threat model, testing strategy, repository layout and open issues. Component detail (schema, protocols, procedures, configuration keys) moved verbatim into one LLD per component, and the external surfaces (MCP tools, CLI) into contracts | [docs/lld/](../lld/), [docs/contracts/](../contracts/) |
| **Stable section numbers.** Every numbered section keeps its Spec v9 number, in this document and in the LLDs, so `SPEC 9.1` or `Spec 7.6.6` in code comments, PRDs and AGENTS.md still points at the right text. Two previously unnumbered parts of section 3 now have numbers: 3.2 (additional configuration keys) and 3.3 (scope resolution and bypass) | "How this spec is organized" below |
| **Schema caught up.** The data model LLD now carries the executable schema (version 21) from `src/store/schema.ts`, which adds `acl_cursors`, `node_origin_sequences`, `node_encryption_keys`, `sealed_key_transfers` and `sessions.cwd` that Spec v9's SQL lacked | [LLD: Data model](../lld/LLD-data-model-v1.md) 4 |
| **Spec v10 draft folded in.** W5.1 approval timestamps (data model 4, digest 11.5); W5.2 crash sweep mechanical work (9.10); W5.3 list-mode ordering (11.2); W5.4 automatic skill sync and W5.5 Codex skills folder (12.2, closes open issue 16); the W5 PreCompact limitation (9.2); W2 sealed pool key transfer (10.6.1, CLI) | The LLD sections named |
| **W4 scheduled backups folded in** (merged after the restructure). A launchd schedule for `ctxd backup` and a backup-age check in `ctxd doctor` | [LLD: Operations](../lld/LLD-operations-v1.md) 12, [Contract: CLI reference](../contracts/cli-reference-v1.md) |
| **Acceptance criteria traced to tests.** Component PRDs now state acceptance criteria in EARS with IDs, and the test plan maps each one to its tests | [Test plan v1](../test/test-plan-v1.md) |

## How this spec is organized

The Spec's section numbers are one namespace shared by this HLD and the LLDs. A number names the same rule wherever it is cited; this table says which file holds its detail.

| Sections | Topic | Detail in |
|---|---|---|
| 1, 2 | Architecture, stack | This document |
| 3 | Files and configuration | This document (file locations); [LLD: Configuration](../lld/LLD-configuration-v1.md) (keys, 3.1 feature flags); [LLD: Hooks](../lld/LLD-hooks-v1.md) (3.3 scope resolution and bypass) |
| 4, 4.1 to 4.3, 5 | Data model, references, paths, kinds, identifiers and clocks | [LLD: Data model](../lld/LLD-data-model-v1.md) |
| 6, 6.1 | Write path, sanitization pipeline | [LLD: Write path](../lld/LLD-write-path-v1.md) |
| 7.1 to 7.4, 7.7 | Replication protocol, policy filter, apply, conflict policies, signed events | [LLD: Replication](../lld/LLD-replication-v1.md) |
| 7.5 | Claims and write intent | [LLD: Claims](../lld/LLD-claims-v1.md) |
| 7.6 | Cleanup operations: flag, quarantine, revert, rollback, purge, tidy | [LLD: Context hygiene](../lld/LLD-context-hygiene-v1.md) |
| 8.1, 8.3, 8.4 | Server instructions, internal API, `ctxd mcp` launcher | [LLD: MCP server](../lld/LLD-mcp-server-v1.md) |
| 8.2, 8.5 | Tools, error codes, aliases, error envelope, metering | [Contract: MCP tools](../contracts/mcp-tools-v1.md) |
| 9 | Hooks | [LLD: Hooks](../lld/LLD-hooks-v1.md) |
| 10.1 | Threat model | This document |
| 10.2 to 10.7 | Tailscale exposure, detectors, review rules, access evaluation, sealed pools (and key transfer), traversal | [LLD: Security and access](../lld/LLD-security-access-v1.md) |
| 11 | Briefs, search, embeddings, importance, signals, digest, local model | [LLD: Briefs and search](../lld/LLD-briefs-search-v1.md) |
| 12 | Operations, mirror and import, native skill sync | [LLD: Operations](../lld/LLD-operations-v1.md); procedures in [runbooks](../runbooks/) |
| 13 | CLI reference | [Contract: CLI reference](../contracts/cli-reference-v1.md) |
| 14 | Testing strategy | This document; per-criterion coverage in the [test plan](../test/test-plan-v1.md) |
| 15, 16 | Repository layout, open issues | This document |

**Rule for changes.** A change that alters system shape (a new listener, a new store, a new trust boundary, a new component) changes this HLD and usually needs an ADR. A change inside one component changes only its LLD or contract: create the next numbered version of that file and update its row above in the next HLD version. Never edit a past version.

### Traceability

| Component PRD | Spec sections | LLD and contracts |
|---|---|---|
| [Feature flags](../prd/components/PRD-feature-flags-v2.md) | 3.1, 9.1 (R7), 13 (`features`) | [LLD: Configuration](../lld/LLD-configuration-v1.md) |
| [Knowledge model](../prd/components/PRD-knowledge-model-v4.md) | 4, 4.1, 4.3, 6, 7.3, 7.4, 8.2 (`context_write`, `context_get`), 13 (`history`, `show`) | [LLD: Data model](../lld/LLD-data-model-v1.md), [LLD: Write path](../lld/LLD-write-path-v1.md), [Contract: MCP tools](../contracts/mcp-tools-v1.md) |
| [Persona pools and access](../prd/components/PRD-pools-access-v3.md) | 4 (pool and persona tables), 6 (step 1), 8.4, 10.5 to 10.7, 11, 13 (`pool`, `persona`, `grant`, `access`, `hold`) | [LLD: Security and access](../lld/LLD-security-access-v1.md), [LLD: MCP server](../lld/LLD-mcp-server-v1.md) |
| [Context hygiene](../prd/components/PRD-context-hygiene-v2.md) | 4 (`flags`, `batches`, purge fields, `read_stats`), 7.6, 8.2 (`context_flag`), 11, 13 | [LLD: Context hygiene](../lld/LLD-context-hygiene-v1.md) |
| [Hooks and agent lifecycle](../prd/components/PRD-hooks-v6.md) | 3.3 (scope resolution), 8.1, 8.3, 9.1 to 9.11 | [LLD: Hooks](../lld/LLD-hooks-v1.md), [LLD: MCP server](../lld/LLD-mcp-server-v1.md) |
| [Claims and write intent](../prd/components/PRD-claims-v4.md) | 4 (`leases`, `claim_overlaps`, `sessions`), 7.4, 7.5, 8.2 (`context_claim`) | [LLD: Claims](../lld/LLD-claims-v1.md) |
| [Trust and safety](../prd/components/PRD-trust-safety-v5.md) | 4 (`clients`), 6, 6.1, 10, 12 (backups, startup checks), 13 (`review`, `client`, `export`) | [LLD: Write path](../lld/LLD-write-path-v1.md), [LLD: Security and access](../lld/LLD-security-access-v1.md), [LLD: Operations](../lld/LLD-operations-v1.md) |
| [Replication and offline work](../prd/components/PRD-replication-v6.md) | 4 (`events`, `sync_state`), 5, 7.1 to 7.4, 7.7, 11.2.1, 12 (migration) | [LLD: Replication](../lld/LLD-replication-v1.md), [LLD: Data model](../lld/LLD-data-model-v1.md) |
| [Briefs and search](../prd/components/PRD-briefs-search-v5.md) | 8.2 (`context_brief`, `context_search`, `context_get`), 8.5, 11 | [LLD: Briefs and search](../lld/LLD-briefs-search-v1.md), [Contract: MCP tools](../contracts/mcp-tools-v1.md) |
| [Filesystem view](../prd/components/PRD-filesystem-view-v2.md) | 4 (`slug`, `mirror_files`), 4.2, 8.2 (`path`), 12.1, 13 (`ls`, `tree`, `read`, `grep`, `open`, `mirror`, `import`) | [LLD: Data model](../lld/LLD-data-model-v1.md), [LLD: Operations](../lld/LLD-operations-v1.md) |
| [Skills](../prd/components/PRD-skills-v3.md) | 4 (`skill_name`, `skill_syncs`), 4.3, 6, 10.4, 11.1, 12.2, 13 (`skills`) | [LLD: Data model](../lld/LLD-data-model-v1.md), [LLD: Operations](../lld/LLD-operations-v1.md) |
| [Memory and journal](../prd/components/PRD-memory-journal-v2.md) | 4 (`significance`, `signals`), 4.1, 4.3, 6, 9.2, 9.3, 11.1 to 11.5, 13 (`remember`, `log`, `journal`, `digest`, `show --why`) | [LLD: Briefs and search](../lld/LLD-briefs-search-v1.md), [LLD: Data model](../lld/LLD-data-model-v1.md) |
| [Mobile inbox](../prd/components/PRD-mobile-inbox-v2.md) | Not yet specified; M7 adds its design to the next HLD version and an `LLD-mobile-inbox` | None yet |

Acceptance criteria for every component, and the tests that verify each one, are in the [test plan](../test/test-plan-v1.md).

Items marked **(verify)** depend on third-party behavior that must be confirmed against current client documentation during implementation.

## 1. Architecture

```
            Main Mac (travels)                               MacBook Air (home hub)
 +--------------------------------------+        +--------------------------------------+
 | Claude Code   Codex   Claude Desktop |        | Claude Code / Codex (via phone SSH)  |
 |     |  hooks    |  hooks      | stdio|        |     |  hooks     |                    |
 |     v           v             v      |        |     v            v                    |
 |  ctxd hook   ctxd hook    ctxd stdio |        |  ctxd hook    ctxd hook               |
 |     \           |             /      |        |      \           /                    |
 |      +-- MCP on 127.0.0.1:7411 -+    |        |       +-- MCP 127.0.0.1:7411 --+      |
 |             ctxd server              |        |             ctxd server              |
 |   SQLite (WAL): events + state + FTS |        |   SQLite (WAL): events + state + FTS |
 |      sync on 127.0.0.1:7412          |        |      sync on 127.0.0.1:7412          |
 |             |                        |        |             |                        |
 |       tailscale serve (tailnet only) |<------>|       tailscale serve (tailnet only) |
 +--------------------------------------+ pull   +--------------------------------------+
```

- **One `ctxd server` process per node.** It owns the database and exposes two listeners, both bound to `127.0.0.1`:
  - an MCP Streamable HTTP endpoint (default port 7411);
  - a sync endpoint (default port 7412), which `tailscale serve` exposes to the tailnet only.
- **`ctxd stdio`** is an MCP stdio server for clients that only launch local processes (Claude Desktop). It proxies to the local `ctxd server` over HTTP, so there is a single writer process per node.
- **`ctxd hook <event>`** is a short-lived CLI that each client's hooks invoke. It calls the local server's internal API and prints the client-specific hook output.
- **Replication** is pull-based: each node periodically pulls events it has not seen from each peer. Push is a lightweight "pull now" notification.

## 2. Stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 24 LTS | Pinned in `.nvmrc` |
| Language | TypeScript 5.x, strict, ESM | |
| MCP | `@modelcontextprotocol/sdk` | Streamable HTTP (stateless) and stdio transports |
| Database | SQLite via `better-sqlite3` | WAL mode, FTS5 |
| Validation | `zod` | Tool input schemas and config |
| IDs | ULID | Sortable, collision-safe offline |
| Vectors (M5) | `sqlite-vec` | Local embedding model only |
| Tests | `vitest`, `fast-check` | Property tests for sync |
| Encryption for backups | `age` | Recipient key per user |

## 3. Files and configuration

| Path | Purpose |
|---|---|
| `~/.config/ctxd/config.toml` | Node config (mode 0600) |
| `~/.config/ctxd/tokens/<client>.token` | Client tokens used by hooks and stdio (mode 0600) |
| `~/Library/Application Support/ctxd/ctxd.db` | Database |
| `~/Library/Application Support/ctxd/sessions/` | Per-session hook state |
| `~/Library/Application Support/ctxd/backups/` | Local encrypted backups |
| `~/Library/Application Support/ctxd/mirror/` | Optional editable Markdown mirror (12.1); never inside a repository |
| `~/Library/Logs/ctxd/` | Logs |

Configuration keys and the feature-flag registry (3.1) are in [LLD: Configuration](../lld/LLD-configuration-v1.md). Scope resolution and bypass (3.3) are in [LLD: Hooks](../lld/LLD-hooks-v1.md).

## 4. Data model

The event log is the source of truth (ADR 0002). Every change is an event that changes exactly one part of one entry (content, status, relations, claim, meta or embedding); entries, relations, leases, signals, FTS and vectors are materialized from the log and rebuilt by `ctxd rebuild`. Local-only tables (`read_stats`, `rejections`, `tool_metrics`, `commits`, mirror and skill-sync state) never replicate. Purge is the only operation that rewrites stored events.

Detail: [LLD: Data model](../lld/LLD-data-model-v1.md), sections 4 (schema and field notes), 4.1 (references and relations), 4.2 (paths), 4.3 (preferences, skills and journal entries) and 5 (identifiers and clocks).

## 5. Identifiers and clocks

ULIDs identify entries, events, nodes and clients; a hybrid logical clock orders events across nodes; a per-node `origin_seq` drives sync cursors. Detail: [LLD: Data model](../lld/LLD-data-model-v1.md) section 5.

## 6. Write path

Every write, from MCP, a hook or the CLI, goes through one function: authenticate and authorize (holding the write when access is below `propose`), check idempotency, validate, sanitize and redact, check the part's revision, set status from the review policy, then append events and materialize in one transaction. A crash never produces a partial or silent write. Detail: [LLD: Write path](../lld/LLD-write-path-v1.md) sections 6 and 6.1.

## 7. Replication

Pull-based, per-origin event replication over the sync listener, exposed to the tailnet only; per-part apply with conflict policies by part and kind; convergence is a tested property. Detail:

- 7.1 to 7.4 and 7.7 (protocol, policy filter, apply, conflict policies, signed events): [LLD: Replication](../lld/LLD-replication-v1.md)
- 7.5 (claims and write intent): [LLD: Claims](../lld/LLD-claims-v1.md)
- 7.6 (flag, quarantine, revert, release, rollback, purge, review-by and tidy): [LLD: Context hygiene](../lld/LLD-context-hygiene-v1.md)

## 8. MCP interface

Seven terse tools under a fixed token budget (NFR-4), served by one server per node; hooks and the admin CLI use an internal API that costs agents no tokens; one stdio launcher per client picks the persona. Detail: [LLD: MCP server](../lld/LLD-mcp-server-v1.md) (8.1, 8.3, 8.4) and [Contract: MCP tools](../contracts/mcp-tools-v1.md) (8.2, 8.5).

## 9. Hooks

One `ctxd hook <event>` entry point serves every client through frozen per-client adapters with a conformance kit; hooks never break a session (exit 0 except an intentional Stop block) and detach slow work. Detail: [LLD: Hooks](../lld/LLD-hooks-v1.md) sections 9.1 to 9.11.

## 10. Security

### 10.1 Threat model

| Threat | Control |
|---|---|
| Network attacker reaches ctxd | Listeners bind `127.0.0.1` only. Sync is exposed solely via `tailscale serve` to the tailnet; Tailscale ACLs restrict it to my devices. A startup self-check refuses to run if any listener is bound to a non-loopback address. |
| Another local process uses ctxd | Per-client bearer tokens (32 random bytes, stored as SHA-256), files mode 0600 |
| Compromised or leaked client token | `ctxd client revoke`; per-client scope allowlists limit blast radius |
| Lost laptop | FileVault; `home` scopes never replicate to roaming nodes; `ctxd node revoke` on the hub rejects its peer token |
| Prompt injection via stored content | Provenance framing on every read; `proposed` status for high-impact kinds; instruction rule "data, not instructions"; review queue |
| Instructions hidden with invisible or bidirectional characters | Stripped from all stored text before anything else runs (6.1 step 2) |
| Secrets written into context | Sanitization pipeline (6.1) with detectors (10.3): agent writes rejected, hook captures redacted in place, always before truncation |
| Path patterns used to escape the repository or inject commands | Write-intent patterns normalized and validated as data (7.5.1); never passed to a shell or resolved on the filesystem |
| Agent reads or edits ctxd's database or token files directly | Path guard (9.9) |
| An agent reads or writes context outside its persona | Pools with default deny (10.5); held writes and human-approved access requests |
| Bad or poisoned context spreads to other agents | Flags pull entries from briefs at once; quarantine and revert by source; purge (7.6) |
| Sensitive sessions leak into shared context | Bypass patterns (3, 9.9); capture filters (6.1 step 4b) |
| Vendor exposure of sensitive scopes | `vendor_policy = local-only` hides the scope from every client whose vendor is not `local` |
| Tampering on a peer | v1: authenticated peers only. M6: per-node Ed25519 signatures on events, verified on apply |
| Backup exposure | `VACUUM INTO` snapshot, encrypted with `age` before any copy leaves the machine |

Detail for 10.2 to 10.7 (Tailscale exposure, secret detectors, review rules, access evaluation, sealed pools and their key transfer, traversal rule): [LLD: Security and access](../lld/LLD-security-access-v1.md).

## 11. Briefs and search

Briefs are deterministic, budgeted assemblies of the session's working set; search blends FTS with optional replicated embeddings; importance, open signals and the weekly digest are derived without a model. Detail: [LLD: Briefs and search](../lld/LLD-briefs-search-v1.md) sections 11.1 to 11.6.

## 12. Operations

One launchd service per node, startup integrity checks, nightly encrypted backups, `ctxd doctor`, hub migration, the optional Markdown mirror and native skill sync. Detail: [LLD: Operations](../lld/LLD-operations-v1.md); step-by-step procedures in [runbooks](../runbooks/).

## 13. CLI reference

Detail: [Contract: CLI reference](../contracts/cli-reference-v1.md).

## 14. Testing

| Layer | What | Tooling |
|---|---|---|
| Unit | HLC, ULID ordering, redaction detectors, scope resolution, brief budgeting | vitest |
| Store | Write path: CAS, idempotency, immutable kinds, review policies, supersede | vitest with temp DBs |
| MCP contract | Each tool via the SDK client over HTTP and stdio; error codes | vitest |
| Tool footprint | `toolDefinitions()` serialized size under the NFR-4 budget | vitest |
| Hooks | Nudge state machine including the loop guard; state-file locking and atomic replace under concurrent hooks | vitest |
| Adapter conformance | Recorded fixtures per client version produce exact stdout, exit codes and server calls; descriptor and fixture coverage cross-checked (9.7) | vitest |
| Claims | Pattern normalization accept and reject tables; the overlap test is symmetric, deterministic and never misses (property test against a brute-force matcher over generated paths); claim, renew, stale, takeover and strict refusal; drift from supplied and derived file lists | vitest, fast-check |
| Knowledge model | Per-part revisions: concurrent content and status edits both apply; relations add-wins merge; `prev` recorded for every change; references resolve through supersession chains; rejections never contain submitted text | vitest, fast-check |
| Scope resolution | Origin URL normalization table (ssh, https, scp-like, trailing `.git`, case); worktree `.git` files; no `git` subprocess; `_me` fallback notice | vitest |
| Crash sweep and workers | Orphaned sessions finalized once; a late SessionEnd after the sweep is a no-op; leftover tickets resumed | vitest |
| Hook limits | SessionStart output never exceeds `session_start_max_chars`; Codex adapter hooks finish within 3 seconds with slow work detached; bypass makes zero server calls; path guard denies data-directory targets | vitest |
| Feature flags | Default, config and environment layers, with environment winning; parent cascade; an unregistered name is on; `tools/list` identical with every flag off; each flag's off path is inert and turning it back on resumes, against the real `ctxd hook` CLI for the hooks ones | vitest, conformance kit |
| Access | Level evaluation table (human, `_me`, profiles, holding scopes, pools by client and tag, temporary grants and expiry, vendor override, strictest pool defaults); held writes create one deduplicated access request, including for a scope that belongs to no pool (`pool_ids: []`); no agent ever writes into a scope below `propose`; session narrowing excludes other pools' scopes from briefs and search | vitest, fast-check |
| Personas | A token's assumed pools bound every operation: a client in two pools reaches only the token's pool; leaving a pool invalidates its grants for existing tokens; revoked and rotated tokens fail everywhere after sync; launcher resolution covers single, multiple (with and without preference), none and `CTXD_POOL`; no token ever appears in logs or environment | vitest |
| Sealed pools | Seal moves all rows; the file is unreadable without the key; attach only while unlocked; detach on lock and window expiry; sealed events replicate only to enrolled nodes and are ciphertext in transit and in backups | vitest |
| Traversal | Every traversal path returns opaque references for unreadable or locked targets, with no kind, title or summary | vitest, fast-check |
| Hygiene | Flag removes an entry from briefs; `unsafe` hides it from search; quarantine by client and window; revert restores `prev`, deletes created entries and turns later foreign edits into conflicts; release restores status; rollback preview matches applied changes | vitest |
| Purge | Content gone from entries, events, FTS and vectors; late-arriving events for a purged entry are stripped on receipt; fingerprint blocks reinsertion; sync cursors unaffected; a rebuild after a purge reconstructs the same stub row from the purge event's own payload, in any replay order (property test over random event sequences including a purge) | vitest, fast-check (sync properties include purges) |
| Paths | Slug rules table (Unicode, punctuation, empty titles, length cut); path format and parse round trip for every kind (property test); `..` and unknown folders rejected; unreadable scopes resolve to `NOT_FOUND`, never `SCOPE_FORBIDDEN`; collisions resolve to a listing | vitest, fast-check |
| Skills | SKILL.md validation (name rule, name equals title, description length, extra keys kept); proposed skills invisible to other agents in search, get, lookup, listings, catalogs and sync; review rules naming `skill` or `preference` refused; name clash picks the earliest and lists the rest; sync never overwrites a folder it did not write or a locally edited file, strips `allowed-tools`, and removes flagged skills | vitest |
| Journal and signals | Significance only on journal; immutability; signals open and close per 11.4, identically on every node after random delivery order; proposed `resolved` links do not close; cross-scope `resolved` links never close a signal; digest idempotent per week and written only by the digest node | vitest, fast-check |
| Importance | Each part bounded to 0..1; monotonic in links, recency and use; table weights; `--why` output matches the score | vitest, fast-check |
| Aliases and errors | Every alias maps to a valid enum value; canonical values map to themselves; free text untouched; `coerced` reported; every error code has a hint and a retryable flag | vitest |
| Mirror | Edit applies with matching rev; stale rev writes a conflict file; deletions become archive requests; own writes do not loop; sealed pools never written | vitest |
| Redaction | Each detector has positive and negative cases; pipeline order (a secret split by a zero-width character is still caught; sanitizing happens before truncation); in-place redaction of hook captures | vitest |
| Sync properties | N in-process nodes, random ops (including claims with write intent), random partitions and heals, random delivery order. Assert identical materialized state hashes (entries, leases, overlap rows), no lost events, `through` cursor correctness under filtering | fast-check |
| Policy | `home` and `local` scopes never reach roaming nodes; `local-only` scopes never returned to cloud-vendor clients | vitest |
| Security | Non-loopback bind refused; token file permission checks; secrets rejected | vitest |
| End to end | Two real servers on different ports; Claude Code and Codex smoke scripts (manual, per release) | scripts |

Each component's acceptance criteria, and the tests that verify them, are mapped in the [test plan](../test/test-plan-v1.md).

## 15. Repository layout

```
ctxd/
  docs/          README.md (doc map), vision/, research/, prd/, adr/, spec/ (HLD), lld/, contracts/,
                 test/, build/, runbooks/, templates/, standards/, glossary.md, assets/
  src/
    cli/         command entry points (init, server, stdio, hook, admin)
    config/      config loading and validation
    core/        hlc, ids, errors, tokens estimate
    store/       schema.sql, db, write path, materializer, review
    tools/       MCP tool schemas, definitions, alias coercion and handlers
    server/      MCP HTTP server, internal API, health
    hooks/       adapters/ (per-client descriptors and limits), nudge state machine, state files, scope resolution, crash sweep, path guard, workers
    model/       entry parts, references, relations, history
    access/      pools, grants, persona tokens, level evaluation, holding scopes, access requests, traversal rule
    sealed/      sealed pool attach, key helper client, encrypted replication
    hygiene/     flags, batches, revert, release, rollback, purge, tidy
    claims/      write-intent normalization, overlap test, claim and release procedures, drift audit
    sync/        pull client, pull server, apply, conflict policies
    security/    auth, sanitization pipeline, detectors, bind checks
    brief/       brief assembly, open signals, skill catalog
    search/      FTS ranking, importance (vectors in M5)
    fsview/      paths, slugs, folder summaries, mirror, import
    skills/      SKILL.md validation, lookup, native sync
    journal/     journal rules, time filters, weekly digest
  test/          unit, contract, conformance/ (hook fixtures per client), sync properties
  deploy/        launchd plist, client config examples, tailscale notes
```

## 16. Open issues

1. Confirm the hook input fields and the "stop hook active" signal for both clients at the pinned versions (9.1, 9.3).
2. Confirm Codex PostCompact output semantics, and whether SessionStart `compact` already covers R3.
3. Decide whether `ctxd stdio` should embed the database directly when the server is not running (simpler) or always proxy (single writer). Current choice: always proxy, and start the server if it is absent.
4. Tailscale identity header availability for tagged nodes (7.1).
5. Whether `task` should defer to Beads (PRD Q6).
6. Whether to support braces and character classes in write-intent globs after real use shows a need (7.5.1).
7. ~~Mechanical claim release for Codex without SessionEnd~~ Resolved in v3: Codex has SessionEnd from rust-v0.145.0; older versions rely on the crash sweep (9.10).
8. Verify the Claude Code plugin display-module API for the sources-used card (9.11) and its minimum version.
9. Confirm Codex default and maximum hook timeouts at the pinned version (9.7 limits).
10. Whether pools should nest (PRD-pools-access PQ-1); v4 keeps them flat.
11. Whether repeated rejections or flags should open a quarantine automatically (PRD-context-hygiene HQ2-2).
12. Purge versus signed events (M6): confirm the signature scheme covers a payload hash that survives purge.
13. Working directory of a client-spawned stdio MCP server: confirm `CLAUDE_PROJECT_DIR` and the process cwd for Claude Code and Codex at pinned versions (8.4).
14. Library choice for SQLCipher-compatible encryption with better-sqlite3, and code signing for `ctxd-keyhelper` (10.6).
15. Whether Claude Desktop's single global MCP config can pass a working directory at all; until confirmed, Desktop sessions use explicit per-persona entries and are a soft boundary.
16. ~~Confirm Codex's user skills folder and SKILL.md frontmatter support at the pinned version (12.2).~~ Resolved: `~/.agents/skills`, confirmed from the Codex source at `rust-v0.145.0` ([LLD: Operations](../lld/LLD-operations-v1.md) 12.2).
17. Whether the mirror should run in the server or a separate process, given FSEvents permissions under launchd (12.1).
18. Whether journal day files should use a fixed time zone from config instead of each node's local zone (4.2).
19. Tune the importance weights and the tidy threshold after a month of real use (11.3).

## Appendix: M1 findings (condensed)

M1's build instructions were to flag every spec ambiguity or implementation gap found while building against v6, rather than silently diverge from it, and to collect those flags for whoever drafted v7. The full trail lived in a changelog file this document replaces; it is condensed here for traceability.

**Resolved in this revision** (see the "Changes in v7" table for exact sections): the `review_policy` schema/spec disagreement (10.4); the purge-replay gap, now fixed by carrying structural fields in the purge event and upserting on replay (7.6.6); the undefined plain-brief character budget (11.1); the `scope: "*"` ranking ambiguity (11.2); the undefined `skill:<name>` priority when no session scope is known yet (4.3); the cross-scope `resolved` link question, settled as same-scope only (11.4); the macOS-only Keychain shim, accepted as intentional given every node is a Mac (8.4); the `ctxd init` genesis exception, now stated explicitly rather than left implicit in the `init` code (4); and the no-pool held write's missing review path, which now opens an access request regardless of whether the scope belongs to a pool (6, step 1).

**Still open, waiting on session and hook-lifecycle machinery that M2 has not yet built:** the interrupted-work notice and `context_brief`'s own `session` output field (11.1); `CLAIM_STALE`'s `holder_session_state` (7.5.3) and `commits_since_claim` (7.5.5, now backed by a `commits` table that nothing writes to yet); release's derived-from-git `changed_files` path and mechanical release on session end (7.5.4); the crash sweep for orphaned leases (7.5.4); quarantine-driven claim suspension (7.6.2); and `ctxd mcp`'s git-origin scope auto-detection (8.4).

**Still open, waiting on later milestones:** "strip late arrivals" needs replication, which does not exist before M3 (7.6.6 step 3); `--rewrite-backups` needs the M4 encrypted backup system (7.6.6 step 5).

**Corrections already made within M1, recorded only for traceability, not as open questions:** `context_brief`'s output shape was corrected from an early `{text: string}` draft to match this document's own tool table before merge; an earlier claim that open signals were never populated because nothing wrote to the `signals` table was wrong (`store/write.ts` has called the signal sync on every write since M1's second slice) and was corrected with a regression test; and purge's FTS cleanup needed the `entries_fts` external-content table's `('delete', ...)` command, since a plain `DELETE` against an external-content FTS5 table silently does nothing.
