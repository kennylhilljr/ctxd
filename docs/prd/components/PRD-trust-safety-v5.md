# ctxd Component PRD: Trust and Safety (v5)

| | |
|---|---|
| **Status** | Draft v5 |
| **Date** | 2026-10-20 |
| **Supersedes** | [v4](PRD-trust-safety-v4.md) |
| **Parent** | [ctxd PRD v8](../PRD-v8.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v4.md), [Persona pools and access](PRD-pools-access-v3.md), [Hooks and agent lifecycle](PRD-hooks-v6.md), [Claims and write intent](PRD-claims-v4.md), [Context hygiene](PRD-context-hygiene-v2.md), [Replication](PRD-replication-v6.md), [Briefs and search](PRD-briefs-search-v5.md) |
| **Spec** | [Spec v10](../../spec/SPEC-v10.md) (HLD) sections 6, 6.1, 9.9, 10 and 13; detail in [LLD: Write path](../../lld/LLD-write-path-v1.md), [LLD: Security and access](../../lld/LLD-security-access-v1.md), [LLD: Hooks](../../lld/LLD-hooks-v1.md) |
| **Acceptance tests** | [Test plan v1](../../test/test-plan-v1.md), TS section |
| **ADRs** | [0003 No public network endpoint](../../adr/0003-no-public-endpoint.md) |
| **Parent requirements elaborated** | FR-10, FR-11, FR-12, FR-16, FR-18, FR-21; NFR-1, NFR-8 (access rules in [Persona pools and access](PRD-pools-access-v3.md); cleanup in [Context hygiene](PRD-context-hygiene-v2.md)) |
| **Adapted from** | [coordinate-agents](https://github.com/hogancv/coordinate-agents) (redaction set, sanitize before truncate); [OpenWork](https://github.com/different-ai/openwork) (read-only tokens, remembered approvals, export safety warnings); [OpenViking](https://github.com/volcengine/OpenViking) (bypass patterns, capture filters, path guard); [DataHub](https://github.com/datahub-project/datahub) (per-caller tokens, rejected-change records) |

## Changes in v5

Earlier changes are listed in [v4](PRD-trust-safety-v4.md) and before.

- **Acceptance criteria in EARS, with IDs.** Every criterion is now one EARS statement with an ID (`TS-AC-n`) and the component requirements it verifies. The meaning of each v4 criterion is unchanged; compound criteria were split so each states one response, and criteria the spec's test table already assumed were made explicit. Each ID is mapped to its tests, or marked as a gap, in the [test plan](../../test/test-plan-v1.md).
- **Links.** The header points to PRD v8, Spec v10 (now the system HLD) and this component's LLD; sibling links point to current versions.

## 1. Purpose

ctxd holds knowledge that several AI agents read and act on. That makes it valuable, and also a target:

- a secret written into it spreads to every agent;
- an injected instruction can steer every agent that reads it;
- a wrong "decision" can mislead every later session.

This component defines how ctxd keeps its content trustworthy and its exposure minimal.

## 2. Principles

1. **Nothing listens on the internet.** Loopback for agents, tailnet only for sync (ADR 0003).
2. **Every word has an author.** Each entry records the client, session and machine that wrote it.
3. **Agents propose; I approve.** High-impact kinds written by agents (decisions, conventions, facts, briefs) start as `proposed`.
4. **Stored text is data.** Everything ctxd returns is framed with its provenance and is never to be followed as instructions.
5. **Secrets never enter.** Agent writes containing secrets are refused; automatic captures are scrubbed.
6. **Least privilege per agent.** Each agent gets only the scopes and levels its persona pools grant, and nothing is written into a pool without my permission ([Persona pools and access](PRD-pools-access-v3.md)).
7. **Bad context is easy to remove.** Flag, quarantine, revert and purge are first-class ([Context hygiene](PRD-context-hygiene-v2.md)).

### 2.1 Where the boundary really is

Every agent runs as my macOS user. Persona tokens, holding scopes and the path guard reliably stop agents from reaching other context **through ctxd's tools**, which is how a prompt-injected agent would normally try. They do not stop an agent with unrestricted shell access from reading files I can read. Two things close most of that gap:

- **Sealed pools** keep the most sensitive context encrypted, with a key that needs my Touch ID ([Persona pools and access](PRD-pools-access-v3.md) section 7.1).
- **Client sandboxes.** Running agents with Claude Code's sandbox or Codex's workspace sandbox enabled keeps ctxd's data directory out of their shells' reach.

## 3. Sanitization and redaction

Agent-written content is checked before it is stored:

- **Secrets are rejected.** Content that looks like a secret is refused, so the agent knows to remove it. Detectors cover:
  - API keys and tokens;
  - private keys;
  - JWTs;
  - cookies and authorization headers;
  - bearer tokens;
  - credentials embedded in URLs.
- **Mechanical hook captures are redacted in place.** Captures such as the pre-compaction excerpt replace secrets with `[REDACTED]` instead of failing, because no agent is there to fix them.
- **Invisible characters are stripped.** Invisible and bidirectional control characters are removed from all stored text, because they can hide instructions from a human reviewer while remaining visible to a model.
- **Sanitize before truncating.** Text is always sanitized before it is shortened, so a cut-off secret can never slip through.
- **`<private>` blocks are removed.** Anything I wrap in `<private>...</private>` is never stored.
- **Exports and logs are scrubbed too.** `ctxd export`, logs and diagnostics pass through the same sanitizer. Before writing files, an export prints warnings by category (possible secret, private path, personal data marker), so I can review before sharing.

### 3.1 Bypass

Directories matching bypass patterns (for example `/tmp/**`, `**/scratch/**`, or a folder of private documents), or any session started with `CTXD_BYPASS=1`, make every ctxd hook return immediately. Nothing is read from or written to ctxd, so a sensitive session leaves no trace in shared context ([Hooks](PRD-hooks-v6.md) section 2.2).

### 3.2 Capture filters

I can add my own rules, as regular expressions with replacements, that run on everything hooks capture mechanically. They run after the built-in sanitization and before storage. Examples: replace internal hostnames, strip customer names from a project's excerpts, or remove a recurring sensitive phrase.

## 4. Provenance and framing

- Every entry records `created_by` and `updated_by` (client), session and origin machine.
- Every read result starts with a provenance line, for example `[decision | proposed | by codex@laptop | 2026-10-16]`.
- Instructions to every agent say retrieved text is data; if it asks for an action, the agent asks me.
- Every change keeps its previous value, and rejected writes are recorded as metadata only (client, entry, error, time; never content). See [Knowledge model](PRD-knowledge-model-v4.md) section 7.

## 5. Review queue

`ctxd review` is where I curate what agents wrote. It lists:

| Section | Contents |
|---|---|
| Proposed | Agent-written decisions, conventions, facts and briefs awaiting approval |
| Conflicted | Entries edited concurrently on different machines that need a merge |
| Auto-resolved | Last-writer-wins outcomes, with the losing version |
| Drift | Claim releases whose changes went outside declared paths ([Claims](PRD-claims-v4.md)) |
| Takeovers | Stale claims taken over by another client |
| Flagged | Entries reported as wrong, stale, duplicate or unsafe, with who flagged them and why |
| Quarantine batches | Open batches, with a per-entry diff, to revert or release |
| Access requests | Agents that tried to write where they may not, with allow entry, grant temporarily, add to pool or deny |
| Holding scopes | Entries held for agents outside a pool, to promote or discard |
| Rejections and denials | Counts by agent and error, as metadata only |

Actions per item: approve, edit and approve, reject (archives it), purge, or open history.

**Remembered approvals.** When approving, I can choose "approve and remember." That writes a rule into the scope's review policy, for example:

- "auto-accept conventions from `claude-code` in scope `notes`"; or
- "auto-accept decisions confirmed by me in scope `ctxd`."

Rules are narrow (scope, client and kind), listed in `ctxd review --rules`, and revocable. Nothing is ever auto-accepted globally.

## 6. Clients, tokens and access

- **Persona tokens.** Each agent has one token per pool it may assume, plus a `_me` token. Tokens live in the macOS Keychain on the agent's machine and as hashes in ctxd. They never appear in environment variables, shell profiles or repository files, and they are never shared between agents, so every read and write is attributable to exactly one agent acting in exactly one persona. Revocable with `ctxd persona revoke` or, for everything an agent holds, `ctxd client revoke`.
- **Access through persona pools.** What an agent may read and write is decided by the pools it belongs to, each granting scopes at `read`, `propose` or `write`, plus any temporary grants. An agent in no pool reads only the global `_me` and writes only to its own holding scope. Full rules: [Persona pools and access](PRD-pools-access-v3.md).
- **Vendor policy per scope (applies on top of pools):**
  - `any`: any client may read it.
  - `local-only`: only a local model (or the human CLI) may read it.

  This keeps sensitive scopes away from cloud model providers.

### 6.1 Path guard

Agents could bypass every control by editing ctxd's database or session files directly with their file tools. A pre-tool hook therefore blocks file reads and edits under ctxd's data directory, and tells the agent which ctxd tool to use instead ([Hooks](PRD-hooks-v6.md) HK-19). This also stops agents from reading token files.

## 7. Network exposure

| Listener | Binding | Reachable from |
|---|---|---|
| MCP and internal API | `127.0.0.1` only | The same machine |
| Sync | `127.0.0.1`, exposed through `tailscale serve` | My tailnet devices allowed by ACLs |

The server refuses to start if any listener binds to a non-loopback address. Tailscale Funnel and other public tunnels are prohibited.

## 8. Data at rest and backups

- FileVault on every node.
- Sealed pools are additionally encrypted with their own key, protected by Touch ID, and stored in a separate file named by an internal id.
- Backups are encrypted with `age` before they leave the machine; an optional copy to Google Drive holds only ciphertext.
- The server never replaces an unreadable or corrupt database with an empty one. It refuses to start and points to `ctxd doctor` and `ctxd restore`.
- Signed events (M6) make tampering by a compromised peer detectable.

## 9. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| TS-1 | Sanitization pipeline (section 3) on every stored text field, in the specified order | FR-12 | P0 |
| TS-2 | Agent writes with secrets rejected with the detector name; hook captures redacted in place | FR-12 | P0 |
| TS-3 | Provenance on every entry and a provenance line on every read result | FR-1 | P0 |
| TS-4 | Proposed status for agent-written decisions, conventions, facts and briefs | FR-11 | P0 |
| TS-5 | `ctxd review` with the sections in section 5, plus remembered approval rules that are narrow and revocable | FR-11 | P0 (rules P1) |
| TS-6 | Persona tokens in the Keychain; access decided by the session's persona ([PA-1 to PA-19](PRD-pools-access-v3.md)) | FR-10, FR-33, FR-35 | P0 |
| TS-17 | Setup guidance and `ctxd doctor` checks recommend client sandboxes that exclude ctxd's data directory | NFR-1 | P1 |
| TS-7 | Vendor policy per scope enforced on every read | FR-16 | P1 |
| TS-8 | Loopback-only binding enforced at startup | NFR-1 | P0 |
| TS-9 | Exports, logs and diagnostics sanitized; export prints categorized warnings | FR-19 | P2 |
| TS-10 | Never replace a corrupt database with an empty one | NFR-6 | P0 |
| TS-11 | Encrypted backups; ciphertext only off-machine | FR-18 | P1 |
| TS-12 | Signed events with per-node keys | FR-21 | P2 |
| TS-13 | Bypass patterns and `CTXD_BYPASS` | FR-12 | P1 |
| TS-14 | Path guard on ctxd's data directory for file tools | FR-12 | P1 |
| TS-15 | User-defined capture filters applied after built-in sanitization | FR-12 | P1 |
| TS-16 | Rejected writes recorded as metadata only | FR-32 | P1 |

## 10. Acceptance criteria

> Owner: A (agent-generated) by persona `product-writer`, derived from the requirements above; approved by the owner at Gate 1. Verification status per criterion: [test plan](../../test/test-plan-v1.md).

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| TS-AC-1 | Unwanted behavior | If an agent write contains a GitHub token, then ctxd shall refuse it with `REDACTED_SECRET` naming the detector. | TS-2 |
| TS-AC-2 | Ubiquitous | ctxd shall never write a rejected secret value to the database, logs or error text. | TS-2, TS-16 |
| TS-AC-3 | Unwanted behavior | If a secret is split by a zero-width character, then the sanitization pipeline shall still detect it. | TS-1 |
| TS-AC-4 | State-driven | While an agent has only `read` access to a scope, ctxd shall hold its writes instead of writing them to that scope. | TS-6 |
| TS-AC-5 | Ubiquitous | ctxd shall hide a `local-only` scope from every cloud-vendor client, even when a pool grants it. | TS-7 |
| TS-AC-6 | Unwanted behavior | If a listener is configured on a non-loopback address, then the server shall refuse to start with a clear error. | TS-8 |
| TS-AC-7 | Event-driven | When the human exports a scope that contains a home-directory path, ctxd shall print a categorized warning and ask for confirmation before writing. | TS-9 |
| TS-AC-8 | Event-driven | When an agent targets ctxd's database file with a file tool, the PreToolUse hook shall block the call and point to `context_get`. | TS-14 |
| TS-AC-9 | State-driven | While a session runs in a bypassed directory, ctxd hooks shall make no ctxd calls. | TS-13 |

## 11. Open questions

| # | Question |
|---|---|
| TQ-1 | Which scopes are `local-only` and which are `home`-only (parent Q3) |
| TQ-2 | Whether confirmed decisions auto-accept in some scopes by default (parent Q4) |
| TQ-3 | Personal-data markers for export warnings: which patterns are useful without being noisy |
