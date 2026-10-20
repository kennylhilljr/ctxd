# ctxd Contract: MCP Tools (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 contract (external surface) |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 8; [LLD: MCP server](../lld/LLD-mcp-server-v1.md) |
| **Implements** | [Briefs and search](../prd/components/PRD-briefs-search-v5.md) FR-2, NFR-4; every component that adds a tool argument |
| **Owner** | A by persona `component-designer`; **human review required at Gate 3** (public contract) |
| **Executable source** | `toolDefinitions()` in `src/tools/list.ts`; the footprint test in `test/unit/tool-footprint.test.ts` measures the same output |
| **Moved from** | Spec v9 sections 8.2 and 8.5 |

Any change to this file is a contract change: it needs a new version of this file, an updated footprint test, and owner approval.

### 8.2 Tools

All tools return JSON text. Descriptions are kept terse; the total `tools/list` payload of the seven tools must stay under about 1,500 tokens (NFR-4, enforced by a test). The server serves the definitions produced by `toolDefinitions()` (`src/tools/list.ts`) verbatim: JSON Schema generated from the zod inputs with the `$schema` keyword removed. The footprint test measures that same output.

| Tool | Input (zod summary) | Output |
|---|---|---|
| `context_brief` | `scope: string`, `size?: "micro"\|"normal"\|"full"` (default `normal`) | `{scope, as_of, node, sync, session, brief: string, notices: string[]}` |
| `context_search` | `scope?: string` (a scope name, or `"*"` for every readable scope; required unless `path` is given), `query: string`, `path?: string` (a `ctxd://` folder prefix, 4.2; its scope is used), `kinds?: Kind[]`, `since?`, `until?: string` (an ISO date or time, or a relative age such as `7d`, `2w` or `12h`; dates and times without a zone are read in the node's time zone, and a date alone as `until` includes that whole day; filters on creation time for `journal`, last update otherwise), `limit?: 1..20` (default 8), `max_tokens?: 200..4000` (default 1000), `include_proposed?: boolean` (default true) | `{results: [{ref, path, scope, kind, title, summary, status, rev, by, updated, snippet, significance?}], truncated, hint?}`. Searching a single scope also searches `_me`. A query of `*` with `since` lists entries by time instead of relevance |
| `context_get` | `ids: string[1..10]` (ULIDs, references, `ctxd://` paths or `skill:<name>`), `related?: boolean` (default false; adds one-hop related entries as summaries), `max_tokens?: 500..8000` (default 3000) | `{entries: [{ref, path, scope, kind, title, summary, body, tags, links, status, rev, by, created, updated, significance?, superseded_by?, siblings?}], folders?: [{path, abstract, overview, children}], related?: [{ref, type, direction, kind, title, summary, status}], truncated, hint?}` |
| `context_write` | `scope`, `kind`, `title (1..200)`, `body? (1..20000 chars; required except for journal, 4.3)`, `summary? (1..200)`, `significance?` (journal only, 4.3), `tags?`, `links?: [{type: supersedes\|implements\|derived_from\|blocks\|relates_to\|points_to\|caused\|resolved, ref, note?}]` (4.1), `id?`, `expected_rev?` (required with `id`; the content revision), `supersedes?`, `confirmed_by_user?`, `session?`, `request_id` | `{id, ref, rev, status}` or error |
| `context_handoff` | `scope`, `action: "write"\|"latest"`, `done?`, `next?`, `open_questions?`, `session?`, `request_id?` (required for write) | write: `{id, rev}`; latest: `{handoffs: [...]}` (latest per client, up to 3) |
| `context_flag` | `ref` (entry id or reference), `problem: "wrong"\|"stale"\|"duplicate"\|"unsafe"`, `reason (1..300)`, `request_id?` | `{ref, status: "flagged", flags: n}` |
| `context_claim` | `scope`, `action: "claim"\|"release"\|"list"`, `task_id?`, `title?` (creates the task if new), `paths?: string[0..50]` (write intent, 7.5.1), `take_over?: boolean`, `changed_files?: string[0..500]` (release only), `ttl_minutes?: 15..1440` (default 120), `request_id?` | claim: `{lease: {task_id, holder, state, paths, expires_at, tentative}, overlaps: [{task_id, holder, patterns}], intent_unknown: string[]}`; release: `{lease, changed_files, drift}`; list: `{leases: [...]}` |

**Held writes.** When the client may not write to the requested scope (6, step 1), `context_write` and `context_handoff write` succeed with `{held: true, held_in: "_hold.<client>", access_request, ref, message}` instead of an error, so the agent can tell the user.

**Purged entries.** `context_get` returns purged entries as stubs (`{ref, kind, purged: true, purged_at, reason}`); search never returns them.

**Truncation hints.** When a result is cut to fit `max_tokens`, `hint` names the narrower call to make, for example `"Fetch fewer ids, or use context_search with path=ctxd://<scope>/decisions/"`.

**Error codes:**

| Code | Meaning |
|---|---|
| `UNAUTHORIZED` | Missing or invalid token |
| `SCOPE_FORBIDDEN` | Scope not allowed for this client, or its vendor policy forbids access |
| `NOT_FOUND` | Entry or scope does not exist |
| `VALIDATION` | Input failed schema or kind rules |
| `REV_CONFLICT` | `expected_rev` does not match the current rev (current rev returned) |
| `IMMUTABLE_KIND` | Attempted content update on a decision, handoff or pointer |
| `REDACTED_SECRET` | Content matched a secret detector |
| `CLAIM_HELD` | Task is already claimed by another client |
| `CLAIM_STALE` | Task's claim has expired; facts returned (7.5.5); retry with `take_over: true` |
| `CLAIM_OVERLAP` | Write intent overlaps an active claim and the scope's intent policy is `strict` |
| `BUDGET_EXCEEDED` | Request asks for more than the maximum budget |
| `IDEMPOTENCY_MISMATCH` | A `request_id` was reused with different input |
| `NOT_ALLOWED` | The operation needs a higher level or the human client (10.5) |

Errors use the envelope in 8.5.

**Output framing:** every returned body is preceded by a provenance line with its reference (`[ctxd:ctxd/01JAB... | decision | proposed | by codex@laptop | 2026-10-16]`) so the model can see who wrote it, whether it is approved, and how to cite it.

### 8.5 Input aliases, error envelope and metering

Implements [Briefs and search v5](../prd/components/PRD-briefs-search-v5.md) section 6. These make agents' mistakes cheap without adding to the tool definitions.

**Input aliases.** Before validation, the server normalizes enum-valued fields. A value is lowercased, spaces and `-` become `_`, and it is then looked up in the field's alias table. Free-text fields are never touched.

| Field | Aliases |
|---|---|
| `kind`, `kinds[]` | Plurals of every kind (`decisions`, `skills`, `journals` ...); `pref` and `prefs` to `preference`; `log` and `journal_entry` to `journal`; `rule` to `convention`; `todo` to `task`; `link` to `pointer` |
| `significance` | `block` and `blocked` to `blocker`; `outage` and `broken` to `incident`; `done` and `shipped` to `milestone`; `insight` to `breakthrough`; `normal` and `info` to `routine` |
| `problem` | `incorrect` to `wrong`; `outdated` to `stale`; `dup` and `duplicated` to `duplicate`; `dangerous` and `malicious` to `unsafe` |
| `size` | `small` and `short` to `micro`; `medium` and `default` to `normal`; `large` and `long` to `full` |
| `action` (handoff) | `get` and `read` to `latest` |
| `action` (claim) | `take` and `start` to `claim`; `done` and `finish` to `release` |
| link `type` | `supersede` and `replaces` to `supersedes`; `implement` to `implements`; `derived` to `derived_from`; `related` and `relates` to `relates_to`; `causes` to `caused`; `resolves`, `fixes` and `fixed` to `resolved` |

A response to a coerced request includes `coerced: [{field, from, to}]`, so the agent learns the canonical value. Aliases never appear in tool definitions, so they cost no tokens. A value that matches nothing still fails with `VALIDATION`, listing the allowed values.

**Error envelope.** Every error has the same shape:

```json
{ "error": { "code": "REV_CONFLICT", "message": "Entry changed since you read it",
  "field": "expected_rev", "hint": "Re-read the entry with context_get and retry with its current rev, or ask the user.",
  "retryable": true, "details": { "current_rev": "4-01JAB..." } } }
```

| Code | Retryable | Hint |
|---|---|---|
| `UNAUTHORIZED` | No | Your ctxd token is missing or revoked; tell the user. |
| `SCOPE_FORBIDDEN` | No | This scope is outside your persona; tell the user if you need it. |
| `NOT_FOUND` | No | Check the reference or path, or search with context_search. |
| `VALIDATION` | Yes | Names the field and, for enums, the allowed values. |
| `REV_CONFLICT` | Yes | Re-read the entry with context_get and retry with its current rev, or ask the user. |
| `IMMUTABLE_KIND` | Yes | Write a new entry instead (with supersedes for decisions). |
| `REDACTED_SECRET` | Yes | Remove the secret the named detector found and retry; refer to credentials by name. |
| `CLAIM_HELD` | No | Another agent holds this task; pick another or ask the user. |
| `CLAIM_STALE` | Yes | Check the returned facts; if the work is not done, retry with take_over: true. |
| `CLAIM_OVERLAP` | No | Tell the user about the overlap before proceeding. |
| `BUDGET_EXCEEDED` | Yes | Lower max_tokens or fetch fewer ids. |
| `IDEMPOTENCY_MISMATCH` | Yes | Use a new request_id for a different write. |
| `NOT_ALLOWED` | No | This operation needs the user. |

**Response metering.** Every tool response, and every brief injected by a hook, adds a `tool_metrics` row: client, tool, scope, characters, estimated tokens (`ceil(chars / 4)`) and whether it was truncated. Rows are local and kept for 90 days. `ctxd stats [--since 7d]` reports totals per tool and client, the largest responses, and brief sizes against their budgets. Nothing is added to responses, so metering costs agents nothing.
