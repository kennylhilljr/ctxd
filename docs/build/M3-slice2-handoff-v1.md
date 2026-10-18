# M3 slice 2 handoff: sync core

Branch `m3/sync-protocol`, off `main` (after PR #26, M3 slice 1, merged). Implements the "sync
core" row of [M3-plan-v1](M3-plan-v1.md): the sync listener, pull protocol, peer auth, and a
puller that applies what it fetches, for the fast-forward case.

## What landed

- **Peer identity and auth**: a new `peers` table (replacing the unused `nodes.peer_token_hash`),
  `ctxd node add-peer|revoke` (`src/cli/node.ts`), `resolvePeerAuth` (`src/server/auth.ts`). Each
  peer relationship bootstraps in three `add-peer` calls, since each side's token can only exist
  once the other side has generated it; the third call updates only `outgoing_token`.
- **The sync listener** (`src/server/sync.ts`, `127.0.0.1:7412` by default, loopback-only):
  `POST /v1/pull` and `POST /v1/notify` (debounced 5s per peer).
- **`servePull`** (`src/sync/pull.ts`): the 7.1 protocol's vector/through/more shape, filtered by
  `src/security/policy.ts`'s existing `mayReplicate` (7.2): reused, not reimplemented.
- **`pullFromPeer` / `applyEvent`** (`src/sync/pull.ts`, `src/sync/apply.ts`): the puller loop,
  and fast-forward/already-known/relations-always materialization (7.3). A missing-parent or
  concurrent content/status event, and every `claim`/`meta` event, are logged but not yet
  materialized; `ctxd sync`'s output reports both counts.
- **`ctxd sync [--peer <name>]`**, flags `sync` (default off) and `sync.serve` (default on,
  nested under `sync`).
- **`ME_SCOPE_ID` fix** (`src/core/kinds.ts`): `_me`'s `scope_id` is now the fixed constant
  `"_me"` on every node instead of `newId()`. Found while writing the end-to-end test: two
  independently initialized nodes could not converge on *any* personal-scope entry otherwise,
  which is the PRD's primary use case. Named project scopes are a separate, still-open gap.

## Verification

- `npm run typecheck`, `npm run build`: clean.
- `npm test`: 496/496 (run with `CTXD_BYPASS` unset, same sandbox caveat as slice 1).
- `test/conformance/sync.test.ts`: two real `ctxd` processes, a real HTTP listener, real
  peer-token auth; a local write pulled and applied; idempotent re-sync; a pull rejected with 401
  for a missing bearer token.
- `/simplify` (4 parallel reviews). Applied: shared `src/server/http.ts` (`readJsonBody`,
  `extractBearerToken`, `parseListen`) replacing three separate copies of the same logic across
  `mcp.ts`, `sync.ts` and `cli/mcp.ts`; a shared `newToken()` in `src/core/hash.ts` replacing four
  separate raw-token-plus-hash call sites (`init.ts`'s own local copy, `client.ts`'s inline
  `createHash` reimplementation, and the new `node.ts`); redundant `DISTINCT` removed from
  `servePull`; a nested ternary replaced with a lookup object in `currentHeadRev`; a 10-field
  manual copy replaced with a spread in `applyEvent`; a redundant `writeFileSync` `mode` option
  alongside an explicit `chmodSync`; an overlap guard on the puller's `setInterval` so a slow pull
  can't pile up concurrent runs; `Promise.all` for starting the two listeners; a role-mismatch
  guard on `ctxd node add-peer`'s token-update path. Skipped, with reasons noted inline: hoisting
  SQLite prepared statements across pull pages (can't hoist across differing `Database`
  instances, and the added complexity isn't worth it at this tool's scale); splitting `add-peer`'s
  create/update paths into separate subcommands (the three-call bootstrap is the right shape,
  per the altitude review).
- `/code-review`: three findings, all fixed. (1) New prose in this doc and `M3-plan-v1.md` used
  em dashes, violating AGENTS.md's writing style rule; replaced with commas/colons/semicolons.
  (2) `POST /v1/pull`'s request validation accepted `vector: null` (`typeof null === "object"`),
  which crashed `servePull` with a 500 instead of a clean 400; fixed, with a regression test in
  `test/conformance/sync.test.ts`. (3) A stale comment in `src/config/flags.ts` claimed
  `sync`/`sync.serve` would be registered "later in M3, not here," contradicting the same file's
  own new registry entries; corrected.

## Owner steps / open items

- Review and merge this PR before slice 3 (conflict policies) branches from it.
- Named project scopes still don't share a `scope_id` across nodes; only `_me` converges until
  slice 6 (ACL and scope metadata as events) lands. Worth knowing before relying on sync for
  anything beyond personal `_me` entries.
- The real-name hygiene gap flagged in the slice 1 handoff is still open.
