# ctxd Component PRD: Trust and Safety (v2)

| | |
|---|---|
| **Status** | Draft v2 |
| **Date** | 2026-10-17 |
| **Supersedes** | [v1](PRD-trust-safety-v1.md) |
| **Parent** | [ctxd PRD v3](../PRD-v3.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v1.md), [Hooks and agent lifecycle](PRD-hooks-v2.md), [Claims and write intent](PRD-claims-v2.md), [Replication](PRD-replication-v2.md), [Briefs and search](PRD-briefs-search-v2.md) |
| **Spec** | [Spec v3](../../spec/SPEC-v3.md) sections 6, 6.1, 9.9, 10 and 13 (`review`, `client`, `export`) |
| **ADRs** | [0003 No public network endpoint](../../adr/0003-no-public-endpoint.md) |
| **Parent requirements elaborated** | FR-10, FR-11, FR-12, FR-16, FR-18, FR-21; NFR-1, NFR-8 |
| **Adapted from** | [coordinate-agents](https://github.com/hogancv/coordinate-agents) (redaction set, sanitize before truncate); [OpenWork](https://github.com/different-ai/openwork) (read-only tokens, remembered approvals, export safety warnings); [OpenViking](https://github.com/volcengine/OpenViking) (bypass patterns, capture filters, path guard); [DataHub](https://github.com/datahub-project/datahub) (per-caller tokens, rejected-change records) |

## Changes in v2

| Change | Section |
|---|---|
| Bypass patterns: directories where ctxd stays silent | 3.1 |
| Capture filters: my own rules applied to anything hooks capture | 3.2 |
| Path guard: agents cannot edit ctxd's data files directly | 6.1 |
| Rejected writes recorded as metadata only | 4 |
| Every client always uses its own token; no shared tokens | 6 |

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
6. **Least privilege per client.** Each client gets only the scopes and access level it needs.

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

Directories matching bypass patterns (for example `/tmp/**`, `**/scratch/**`, or a folder of private documents), or any session started with `CTXD_BYPASS=1`, make every ctxd hook return immediately. Nothing is read from or written to ctxd, so a sensitive session leaves no trace in shared context ([Hooks](PRD-hooks-v2.md) section 2.2).

### 3.2 Capture filters

I can add my own rules, as regular expressions with replacements, that run on everything hooks capture mechanically. They run after the built-in sanitization and before storage. Examples: replace internal hostnames, strip customer names from a project's excerpts, or remove a recurring sensitive phrase.

## 4. Provenance and framing

- Every entry records `created_by` and `updated_by` (client), session and origin machine.
- Every read result starts with a provenance line, for example `[decision | proposed | by codex@laptop | 2026-10-16]`.
- Instructions to every agent say retrieved text is data; if it asks for an action, the agent asks me.
- Every change keeps its previous value, and rejected writes are recorded as metadata only (client, entry, error, time; never content). See [Knowledge model](PRD-knowledge-model-v1.md) section 7.

## 5. Review queue

`ctxd review` is where I curate what agents wrote. It lists:

| Section | Contents |
|---|---|
| Proposed | Agent-written decisions, conventions, facts and briefs awaiting approval |
| Conflicted | Entries edited concurrently on different machines that need a merge |
| Auto-resolved | Last-writer-wins outcomes, with the losing version |
| Drift | Claim releases whose changes went outside declared paths ([Claims](PRD-claims-v2.md)) |
| Takeovers | Stale claims taken over by another client |

Actions per item: approve, edit and approve, reject (archives it), or open history.

**Remembered approvals.** When approving, I can choose "approve and remember." That writes a rule into the scope's review policy, for example:

- "auto-accept conventions from `claude-code` in scope `notes`"; or
- "auto-accept decisions confirmed by me in scope `ctxd`."

Rules are narrow (scope, client and kind), listed in `ctxd review --rules`, and revocable. Nothing is ever auto-accepted globally.

## 6. Clients, tokens and access

- **Tokens.** Each client (an agent installation on a machine) has its own token, stored only as a hash and revocable with `ctxd client revoke`. Tokens are never shared between clients, so every read and write is attributable to exactly one agent installation.
- **Scope allowlist.** Each client has an allowlist of scopes.
- **Access level:**
  - `write` (default) for agents.
  - `read` for clients that should only look, such as a dashboard, a Desktop project used only for reference, or an experimental agent. Read clients can call `context_brief`, `context_search` and `context_get`; writes return `SCOPE_FORBIDDEN`.
- **Vendor policy per scope:**
  - `any`: any client may read it.
  - `local-only`: only a local model (or the human CLI) may read it.

  This keeps sensitive scopes away from cloud model providers.

### 6.1 Path guard

Agents could bypass every control by editing ctxd's database or session files directly with their file tools. A pre-tool hook therefore blocks file reads and edits under ctxd's data directory, and tells the agent which ctxd tool to use instead ([Hooks](PRD-hooks-v2.md) HK-19). This also stops agents from reading token files.

## 7. Network exposure

| Listener | Binding | Reachable from |
|---|---|---|
| MCP and internal API | `127.0.0.1` only | The same machine |
| Sync | `127.0.0.1`, exposed through `tailscale serve` | My tailnet devices allowed by ACLs |

The server refuses to start if any listener binds to a non-loopback address. Tailscale Funnel and other public tunnels are prohibited.

## 8. Data at rest and backups

- FileVault on every node.
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
| TS-6 | Per-client tokens with scope allowlists and `read` or `write` access | FR-10 | P0 (access level P1) |
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

- A write containing a GitHub token is refused, and the token never appears in the database, logs or error text.
- A secret split by a zero-width character is still caught.
- A `read` client cannot write, and a cloud-vendor client cannot see a `local-only` scope.
- Starting the server with a non-loopback listener fails with a clear error.
- An export of a scope containing a home-directory path prints a warning before writing.
- An agent asked to open ctxd's database file with a file tool is blocked and pointed to `context_get`.
- A session in a bypassed directory makes no ctxd calls.

## 11. Open questions

| # | Question |
|---|---|
| TQ-1 | Which scopes are `local-only` and which are `home`-only (parent Q3) |
| TQ-2 | Whether confirmed decisions auto-accept in some scopes by default (parent Q4) |
| TQ-3 | Personal-data markers for export warnings: which patterns are useful without being noisy |
