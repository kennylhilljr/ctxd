# ctxd Spec Changelog: M1 Implementation Findings (toward v7)

| | |
|---|---|
| **Status** | Changelog, not a spec revision |
| **Date** | 2026-10-18 |
| **Scope** | Every ambiguity, gap or implementation choice found while building M1 (slices 1 through 8) against [Spec v6](SPEC-v6.md) |
| **Authoritative spec** | [Spec v6](SPEC-v6.md) remains current. This file does not change it; it collects findings for whoever drafts a real v7 |

M1's build instructions were to flag spec problems rather than silently diverge, and to collect
those flags here rather than editing v6 in place. Each entry below names the section of v6 it
concerns, the real code (file and line, as of M1's last PR) that encodes the finding, and a
short note on what a v7 draft needs to decide. None of these blocked M1: each is either a
pragmatic scoped-down default (clearly marked in the code with a comment), a genuine gap deferred
to a later milestone, or a spec/schema disagreement worth resolving before more code is built on
either side of it.

## Spec/schema disagreements

| v6 section | Finding |
|---|---|
| 10.4 | `scopes.review_policy` defaults to `'{}'` in the schema (`src/store/schema.ts`), but 10.4 describes it as "a JSON list of rules." `store/write.ts`'s `reviewedStatus` treats anything that isn't a JSON array as "no rules yet" rather than crashing, but the schema's own default and the spec's own description of the same column still disagree. **v7 should either fix the schema default to `'[]'` or restate 10.4 to describe an object.** |
| 7.6.6 step 2 | "Rewrite `payload` and `prev` of every stored event for that entry to `{"purged": true}`." Taken literally, replaying a neutered `create` event (e.g. a rebuild, or a peer applying synced events after the fact) has no `kind`/`slug` left to reconstruct even a placeholder row: `applyEvent` would crash trying to `INSERT` with no `kind`. M1's fix (`src/store/materialize.ts`, the guard at the top of `applyEvent`) is to skip neutered events entirely during replay, which is safe but means **a rebuild after a purge leaves the entry absent from `entries`, not present with placeholder content**, a real divergence from "purge once, see `[purged]` everywhere forever" if a rebuild ever runs after one. **v7 should either have the purge event itself carry enough structural data (`kind`, `slug`) to reconstruct a stub row via UPSERT regardless of replay order, or explicitly document that a purged entry's placeholder row is a cache that a rebuild does not guarantee to reproduce.** |

## Gaps where the spec gives no concrete number

| v6 section | Finding |
|---|---|
| 11.1 | `session_start_max_chars` (default 9,500) is specified only for the *hook-injected* brief. A plain `context_brief` tool call has no stated total character budget. `src/brief/assemble.ts`'s `BASE_CHARS` (9,500 / 3,000 / 28,500 for normal/micro/full) is this build's own reasonable choice, not a number from the spec. **v7 should either state a number for the plain tool call explicitly, or state that it's the same 9,500/size-scaled budget on purpose.** |
| 11.2 | With `scope: "*"`, every readable scope is multiplied 0.9 (`_me`/profile) or 0.8 (everything else), since "there is no single 'home' scope to distinguish in this mode" (`src/search/fts.ts`'s `candidateScopes`). The spec's wording implies scopes should be distinguishable in this mode the same way they are for a named-scope search, but doesn't say how when there is no anchor scope to compare against. **v7 should either accept the 0.8-for-everything-non-`_me` default as intentional, or define what "home" means with no scope given.** |

## Session/hook-lifecycle dependent gaps (M2, not spec problems; sequencing notes)

All of these need the hook lifecycle's `sessions` upserts (9.3: "every hook call upserts the
sessions row") or other M2+ machinery that doesn't exist yet. None of them are spec ambiguities;
each is a real feature M1 correctly does not attempt, flagged so M2's hook work knows to close
them.

| v6 section | Gap | Where it's flagged in code |
|---|---|---|
| 11.1 | The interrupted-work notice, and `context_brief`'s own `session` output field, both depend on the hook lifecycle. M1's brief returns `session: null` and never reads or writes `sessions`. | `src/brief/assemble.ts` |
| 7.5.3, 7.5.5 | `CLAIM_STALE`'s `holder_session_state` always reports `"unknown"` (no `sessions` writer yet). `commits_since_claim` is always `[]`: there's no commit-pointer table in the schema at all yet, not just no writer for one. | `src/store/claim.ts` |
| 7.5.4 | Release's "derived from git" `changed_files` path (hook-recorded commit/checkpoint facts) has no M1 equivalent; without an agent-supplied `changed_files`, release always records it as unknown and never computes drift. | `src/store/claim.ts` |
| 7.5.4 | Mechanical release on session end, and the crash sweep for orphaned ("lost") leases, are both hook/daemon concerns with no M1 equivalent. A lease only ever changes state through an explicit `claim`/`release` call in M1. | `src/store/claim.ts` |
| 7.6.6 step 3 | "Strip late arrivals" is a sync-time concern; there is no replication in M1 (that's M3). | `src/store/purge.ts` |
| 7.6.6 step 5 | `--rewrite-backups` needs the M4 encrypted backup system, which doesn't exist yet. | `src/store/purge.ts` |
| 7.6.2 | Quarantine-driven claim suspension isn't implemented, since quarantine itself is out of M1's scope. | `src/store/claim.ts` |
| 8.4 | `ctxd mcp`'s persona resolution uses only `CTXD_POOL` and an explicit `--scope`; `resolveScope`'s git-origin auto-detection needs hook-recorded git facts that land with M2's hooks. | `src/cli/mcp.ts` |
| 6, step 1 | A held write to a scope that belongs to no pool at all opens no `access_requests` row (the spec says a row opens "only when the target scope belongs to a pool"), so it has no reviewable path; the only present-day recourse is a direct `client_grant` from the human. Worth deciding in v7 whether that's the intended dead end or whether a pool-less scope should get some other review surface. | `src/store/write.ts` |

## Implementation choices flagged for a future spec to pin down explicitly

| v6 section | Finding |
|---|---|
| 4.3, 8.2 | `context_get`'s `ids` parameter has no `scope` field, so a `skill:<name>` lookup has no way to know the caller's "session scope" the way 4.3's priority order (session scope, then pool profile, then `_me`) assumes. M1 searches the whole readable set and breaks ties by earliest `created_hlc`. **v7 should either add a `scope` hint to `context_get`, or restate 4.3's priority order for a tool that genuinely has none.** |
| 11.4 | `journal/sync.ts`'s signal resolution is scope-local: a `resolved` link from an entry in a *different* scope than its target isn't counted. The spec doesn't say resolution must be same-scope; this build assumes it, since cross-scope resolution is rare and the alternative (scanning every scope's relations for every signal) is considerably more expensive. |
| 8.4 | No Keychain library is pinned in `package.json`; `src/access/keychain.ts` shells out to the macOS `security` binary rather than adding a native dependency. This works only on macOS. **v7 (or an earlier milestone, if ctxd needs to run on Linux/Windows before then) should name a cross-platform secret-storage approach.** |
| 4 (genesis) | `ctxd init` bootstraps the node, the human client and the global `_me` scope with direct inserts, not `acl` events, since there is no prior node/client/scope yet to author one from (ADR 0002 otherwise governs every later write). This is a one-time, clearly-scoped exception; v7 should state it as one explicitly rather than leave it implicit in the `init` code. |

## Corrections already made within M1 (recorded here for traceability, not open questions)

These were real bugs in the first draft of their own PR, found and fixed before merge. Listed
here only so a reviewer of this changelog knows they're closed, not still open:

- `context_brief`'s output shape was built as `{text: string}` before being corrected to match
  8.2's actual tool table (`{scope, as_of, node, sync, session, brief, notices}`). Fixed in PR #5
  before merge.
- An earlier draft of PR #5 claimed open signals were empty because nothing wrote to the
  `signals` table. That was wrong: `store/write.ts` has called `journal/sync.ts`'s
  `syncSignalsForScope` on every write since slice 2. Corrected in PR #5 before merge, with a
  regression test.
- `entries_fts` is an external-content FTS5 table; a plain `DELETE FROM entries_fts WHERE rowid
  = ?` silently does nothing on it. Purge's FTS cleanup needed the same `('delete', ...)` command
  `syncFtsRow` already used. Fixed in PR #7 before merge.
