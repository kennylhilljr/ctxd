# ctxd LLD: Write Path and Sanitization (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 6 |
| **Implements** | [Knowledge model](../prd/components/PRD-knowledge-model-v4.md), [Trust and safety](../prd/components/PRD-trust-safety-v5.md) (sanitization and redaction requirements), [Persona pools and access](../prd/components/PRD-pools-access-v3.md) (held writes) |
| **Owner** | A (agent-generated) by persona `component-designer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/store/write.ts`, `src/security/` |
| **Moved from** | Spec v9 sections 6 and 6.1 |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 6. Write path

Every write, whether from MCP, a hook or the CLI, goes through one function:

1. **Authenticate and authorize.** Authenticate the client token, then evaluate access to the target scope (10.5). Outcomes:
   - **`write`:** continue normally.
   - **`propose`:** continue, forcing the final status to `proposed`.
   - **`read` or none:** the write is **held**. It is stored in the client's holding scope `_hold.<client>` (created if needed) as `proposed`. An access request for the target scope is opened, or its attempt count is increased, regardless of whether the target scope belongs to a pool: `pool_ids` is the JSON empty array `[]` when it belongs to none, so every held write has a reviewable path (`ctxd review`, M2) rather than only a direct `client_grant` from the human for a pool-less scope. The result is `{held: true, held_in, access_request, ref}` with a message telling the agent that the write needs the user's permission. Nothing is written to the target scope.
   - **Vendor policy forbids the scope:** `SCOPE_FORBIDDEN`, with nothing held.
2. **Idempotency.** Compute `request_hash` over the canonical JSON of the validated input, excluding `request_id`. Then compare with any earlier write by this client using the same `request_id`:
   - **Same hash:** return the stored result.
   - **Different hash:** return `IDEMPOTENCY_MISMATCH` and write nothing. A retry must never silently become a different write.
3. **Validate** the input with zod, after alias coercion (8.5). Kind-specific rules apply: for example, `handoff` requires `done` or `next`; `body` is required except for `journal`; `significance` is allowed only on `journal`; `skill` bodies must be valid SKILL.md files (4.3).
4. **Sanitize and redact** using the pipeline in 6.1. For agent writes, a secret match rejects the write with `REDACTED_SECRET`, naming the detector but never echoing the value.
5. **Concurrency.** For updates, compare `expected_rev` with the current revision of the part being changed (`content_rev` for `context_write`; `status_rev` for review actions; `relations_rev` for relation-only changes). On a mismatch, return `REV_CONFLICT` with the current rev, title and a summary. Nothing is written.
6. **Status.** Apply the scope's review policy to set `active` or `proposed`. Defaults:

| Kind | Default status when written by an agent |
|---|---|
| `handoff`, `status`, `pointer`, `task`, `note`, `journal` | `active` |
| `decision`, `convention`, `fact`, `lesson`, `brief`, and `journal` with significance `decision` | `proposed` |
| `preference`, `skill` | Always `proposed`; review rules cannot change it (10.4) |
| Any kind written by the `human` client (CLI) | `active` |

A scope may set `{"decision": "auto-if-confirmed"}` so decisions with `confirmed_by_user: true` become `active`.

7. **Append and materialize.** In one transaction:
   - append one event per changed part (assigning HLC and `origin_seq`), each with `prev` holding the prior values of the changed fields;
   - materialize the entry and its relations;
   - update FTS;
   - mark a superseded entry if `supersedes` is set, and queue supersession notices (4.1);
   - open or close signals (11.4).
8. **Return** `{entry_id, ref, rev, status}`, where `ref` is the entry's reference and `rev` is its content revision.

**Rejected writes.** Any write refused at steps 1 to 5 adds a `rejections` row: client, scope, entry, tool, error code, and detector names or revision numbers. Submitted text is never stored. Rejections are local to the node, kept for 90 days, and summarized in `ctxd review` (for example "codex@laptop: 4 REV_CONFLICT on ctxd:ctxd/01JAB... this week").

**Failure semantics (PRD NFR-10):**

- **All or nothing.** Step 7 is a single SQLite transaction. If it fails, nothing is visible and the caller receives an explicit error.
- **No silent retries.** The server never retries a write on its own. Clients retry with the same `request_id`, which is safe because of step 2.
- **A crash is never a lie.** A crash between commit and response leaves a committed write, and the retry returns the stored result. A crash before commit leaves nothing.

### 6.1 Sanitization and redaction pipeline

Applied to every text field (title, body, tags, link notes) in this order. The order matters: control characters are removed before detection so they cannot split a secret, and everything is sanitized before any truncation.

| Step | Action | Agent writes | Mechanical hook captures |
|---|---|---|---|
| 1 | Remove `<private>...</private>` blocks | Replace with `[private content removed]` | Same |
| 2 | Strip invisible and control characters: C0 and C1 controls except `\n` and `\t`, zero-width characters U+200B to U+200F, bidirectional overrides U+202A to U+202E and U+2066 to U+2069, and U+FEFF | Strip | Strip |
| 3 | Normalize to Unicode NFC | Yes | Yes |
| 4 | Run secret detectors (10.3) | **Reject** with `REDACTED_SECRET` | **Redact in place** with `[REDACTED]` |
| 4b | Apply user `capture_filters` (3), in order | Not applied | Applied |
| 5 | Enforce size limits; truncate only mechanical captures (never agent writes, which fail `VALIDATION` instead) | Validate | Truncate with marker |
