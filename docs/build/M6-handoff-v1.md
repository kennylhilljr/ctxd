# M6 handoff v1

## Commits

- `33d8c7d` `M6 slice 1: sign and verify event payloads`
- `9278c92` `M6 slice 2: add Markdown export mirror and import`
- `e75ab2f` `M6 slice 3: add sealed pool storage and replication`
- `0745323` `M6 slice 4: add node adoption and migration runbook`
- `bebd349` `M6 slice 5: add local model proposals and exit checks`
- `5c08795` `M6 slice 6: route sealed requests without plaintext copies`
- `6e9290a` `M6 slice 7: persist mirror stop and confirm archives`
- `1eddbb4` `M6 slice 8: harden sealed sync and signed purge checks`
- `2367129` `M6 slice 9: preserve sealed ciphertext in backups`
- `3b0aa00` `M6 slice 10: replay sealed purges on unlock`
- `7b022e7` `M6 slice 12: bind signed event envelopes`
- `4ac9669` `M6 slice 13: bind peer identity and keys`
- `0ccc544` `M6 slice 14: verify purge stripping state`
- `2684d80` `M6 slice 15: route sealed MCP scopes`
- `74cf1bc` `M6 slice 16: close mirror safety gaps`
- `10fd62a` `M6 slice 17: constrain local model writes`
- `9089643` `M6 slice 18: make node adoption recoverable`
- `12f711d` `M6 slice 19: update corrective handoff`

Nothing was pushed and no pull request was opened.

## Delivered

Signed events use one Ed25519 key per node. The signature covers the complete immutable event envelope and separate retained hashes for payload and prior values. Tests mutate each signed field. Authenticated peer enrollment pins remote node identities and public keys. Once a key is pinned, unsigned events at or after its cutoff are rejected. Duplicate event ids are discarded before untrusted duplicate metadata is inspected. Raw arrivals are verified before purge stripping, stripped rows carry trusted local metadata, and rebuild verifies the complete log before clearing materialized tables.

Markdown import and mirror now enforce independent content and status revisions. Status-only edits remain valid for immutable entry kinds. Mirror reconciliation removes stale plaintext, tracking rows, conflict files and archive requests when an entry disappears or becomes sealed. The live mirror flag is checked on every pass. Import rejects symbolic links, refuses sealed targets, performs no database writes during dry runs, reports sanitizer warnings, and requires `--yes` before applying warned input.

Sealed pool unlock no longer copies plaintext rows into `ctxd.db`. Scope-addressed MCP calls are routed into the encrypted store after access evaluation. Sealed sync reads and applies events in that store, and locked purge work replays through the normal purge path on unlock. One durable main-database allocator issues origin sequence numbers for shared and sealed writes. Backups wrap sealed files and the stable node signing key with `age`; restore reinstates them with the main database. Remote sealed enrollment fails closed because authenticated key transfer is not implemented.

The local model client receives no automatic broad grant. It reads only scopes with an explicit, unexpired `propose` or `write` grant, retries summary and lesson proposals independently, and uses separate idempotency keys. Invalid local model configuration is rejected before either listener starts. Node adoption validates DNS-label names and restores the original configuration if the database transaction fails.

Spec v9 contains the shipped M6 formats and behavior. Optional M6 features are registered off by default.

## Verification

Each corrective slice ran `npm run typecheck` and `npm test`. The latest run passed 703 tests across 61 files, with four sync conformance cases skipped after their setup failed in the sandbox. Focused signed event, mirror, sealed pool, purge, backup, local model, adoption and sync property tests passed.

The unfiltered suite cannot pass in this sandbox. Twenty-four hook conformance cases and the real two-node sync case fail because `tsx` cannot open its local IPC socket. Three MCP tests fail because loopback listeners receive `EPERM`. One launchd test cannot load a job. These are environment failures, not assertion failures in M6 code. Scratch `ctxd node adopt` preserved its node ID and passed database integrity; `ctxd doctor` could not inspect FileVault in the sandbox.

## Stop conditions and owner work

The following checks require the owner’s hardware, identity or live configuration, so section 0 reserves them for the owner:

1. Build and sign `ctxd-keyhelper` using [ctxd-keyhelper-build-v1.md](ctxd-keyhelper-build-v1.md). Install it on the service path, create a scratch sealed key, confirm the user-presence prompt with Touch ID, read the key again and remove it.
2. Rehearse [M6-hub-migration-runbook-v1.md](M6-hub-migration-runbook-v1.md), then move the real hub and the real `tailscale serve` configuration. Do not enable Funnel. Keep both application listeners on loopback.
3. Do not enroll the real Mac Studio yet. The command now refuses remote enrollment until authenticated key transfer is implemented. A refusal is the expected fail-closed result.
4. Grant the `local-model` client `propose` access only to the intended scopes. Point `local_model.endpoint` at the owner’s loopback model, enable `local_model`, run `ctxd model suggest`, and inspect the proposed entries before approval.

## External production-provider blocker

The SQLCipher package still cannot be installed because this environment cannot resolve `registry.npmjs.org`. The attempted `npm install better-sqlite3-multiple-ciphers@13.0.3 --save` ended with `ENOTFOUND`. `SqlCipherDatabaseProvider` fails closed with an installation error, while tests use `TestDatabaseProvider`. No substitute encryption was added. Before enabling sealed pools, install that exact package, record it in `package.json` and `package-lock.json`, then run the sealed tests against the production provider.

No weaker encryption provider was substituted. `SqlCipherDatabaseProvider` still fails closed with a precise installation error. Remote sealed enrollment also fails closed until authenticated key transfer is implemented.

## Exit checks still to run

On an unrestricted scratch machine, run the exact full suite, start two loopback servers, exchange signed events, purge the signed entry, sync again and rebuild both databases. Exercise a mirror edit and stale revision conflict through the running server. After the SQLCipher package is available, repeat sealed convergence, duplicate delivery, lock expiry and purge tests with the production provider.
