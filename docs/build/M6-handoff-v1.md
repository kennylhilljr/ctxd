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

Nothing was pushed and no pull request was opened.

## Delivered

Signed events use one Ed25519 key per node, retain their payload hash through purge, verify raw late arrivals before stripping them, verify during sync apply and rebuild, and continue verification with the feature switched off. Markdown export, import, mirror revision checks, conflict files, archive requests, new-file ingestion and server reconciliation are present. `ctxd mirror stop` now switches the mirror feature off in the persistent config. `ctxd archive-request confirm <ref> --yes` archives a requested entry through a status event and clears the request.

Sealed pool unlock no longer copies plaintext rows into `ctxd.db`. Routed callbacks operate on the encrypted store, sealed sync reads and applies events there, and locked purge work replays through the normal purge event path on unlock. Sealing removes the main FTS copy. Mirror and export tests assert that sealed plaintext is excluded. Backups wrap each sealed database file directly with `age`, copy it with the main backup, prune it with the same generation and restore it into `sealed/`. Keys remain outside both databases. Node adoption preserves the node ID and has a migration runbook. The local model worker accepts only loopback HTTP endpoints and writes machine-labeled summary and lesson proposals through the normal write path.

Spec v9 contains the shipped M6 formats and behavior. Optional M6 features are registered off by default.

## Verification

Each corrective slice ran `npm run typecheck` and `npm test`. The latest run passed 684 tests across 61 files. Focused signed event, mirror, sealed pool, purge, backup and sync tests passed. The earlier `npm run build` passed. A final build remains to be run after the findings below are closed.

The unfiltered suite cannot pass in this sandbox. Twenty-four hook conformance cases and the real two-node sync case fail because `tsx` cannot open its local IPC socket. Three MCP tests fail because loopback listeners receive `EPERM`. One launchd test cannot load a job. These are environment failures, not assertion failures in M6 code. Scratch `ctxd node adopt` preserved its node ID and passed database integrity; `ctxd doctor` could not inspect FileVault in the sandbox.

## Stop conditions and owner work

The following checks require the owner’s hardware, identity or live configuration, so section 0 reserves them for the owner:

1. Build and sign `ctxd-keyhelper` using [ctxd-keyhelper-build-v1.md](ctxd-keyhelper-build-v1.md). Install it on the service path, create a scratch sealed key, confirm the user-presence prompt with Touch ID, read the key again and remove it.
2. Rehearse [M6-hub-migration-runbook-v1.md](M6-hub-migration-runbook-v1.md), then move the real hub and the real `tailscale serve` configuration. Do not enable Funnel. Keep both application listeners on loopback.
3. Enroll the real Mac Studio in each intended sealed pool. Verify a locked reference is opaque, an unlock prompts once, expiry locks it again, and an enrolled peer receives ciphertext.
4. Point `local_model.endpoint` at the owner’s loopback model, enable `local_model`, run `ctxd model suggest`, and inspect the proposed entries before approval.

## Unresolved findings

The SQLCipher package still cannot be installed because this environment cannot resolve `registry.npmjs.org`. The attempted `npm install better-sqlite3-multiple-ciphers@13.0.3 --save` ended with `ENOTFOUND`. `SqlCipherDatabaseProvider` fails closed with an installation error, while tests use `TestDatabaseProvider`. No substitute encryption was added. Before enabling sealed pools, install that exact package, record it in `package.json` and `package-lock.json`, then run the sealed tests against the production provider.

The storage and sync paths now use the sealed database without copying plaintext into the main database, and queued purges replay on unlock. Ordinary MCP and CLI read and write handlers have not all been connected to `SealedPoolStore.forScope`, so an unlocked sealed entry is not yet reachable through every normal command. Origin sequence allocation is also local to each database connection, which can duplicate one node's sequence numbers across shared and sealed stores. These are engineering gaps, not section 0 stop conditions. Do not enable `sealed_pools` on real data until both are fixed.

Enrollment filtering still trusts the requesting node ID in the authenticated pull body. Peer authentication is not yet pinned to a remote node ID, so a peer token holder could claim another enrolled node ID. The enrollment command also only resolves the local row in `nodes`. This must be corrected before sealed replication is safe for real data.

## Exit checks still to run

On an unrestricted scratch machine, run the exact full suite, start two loopback servers, exchange signed events, purge the signed entry, sync again and rebuild both databases. Exercise a mirror edit and stale revision conflict through the running server. After the SQLCipher blocker is fixed, repeat the sealed convergence, duplicate delivery, lock expiry and purge tests with the production database provider. Run the tool-footprint test once more after those changes.
