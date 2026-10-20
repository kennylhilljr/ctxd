# M6 handoff v1

## Commits

- `33d8c7d` `M6 slice 1: sign and verify event payloads`
- `9278c92` `M6 slice 2: add Markdown export mirror and import`
- `e75ab2f` `M6 slice 3: add sealed pool storage and replication`
- `0745323` `M6 slice 4: add node adoption and migration runbook`
- `bebd349` `M6 slice 5: add local model proposals and exit checks`

Nothing was pushed and no pull request was opened.

## Delivered

Signed events use one Ed25519 key per node, retain their payload hash through purge, verify during sync apply and rebuild, and continue verification with the feature switched off. Markdown export, import, mirror revision checks, conflict files, archive requests, new-file ingestion and server reconciliation are present. Sealed-pool code includes injected key and database providers, XChaCha20-Poly1305 event envelopes, enrollment filtering, lifecycle tests and a macOS key helper. Node adoption preserves the node ID and has a migration runbook. The local model worker accepts only loopback HTTP endpoints and writes machine-labeled summary and lesson proposals through the normal write path.

Spec v9 contains the shipped M6 formats and behavior. Optional M6 features are registered off by default.

## Verification

Each slice ran `npm run typecheck` and the exact `npm test` command. The final sandbox-compatible suite passed 669 tests across 61 files. `npm run build` passed. Focused signed event, mirror, sealed-pool, adoption, local-model and sync property tests passed.

The unfiltered suite cannot pass in this sandbox. Twenty-four hook conformance cases and the real two-node sync case fail because `tsx` cannot open its local IPC socket. Three MCP tests fail because loopback listeners receive `EPERM`. One launchd test cannot load a job. These are environment failures, not assertion failures in M6 code. Scratch `ctxd node adopt` preserved its node ID and passed database integrity; `ctxd doctor` could not inspect FileVault in the sandbox.

## Stop conditions and owner work

The following checks require the owner’s hardware, identity or live configuration, so section 0 reserves them for the owner:

1. Build and sign `ctxd-keyhelper` using [ctxd-keyhelper-build-v1.md](ctxd-keyhelper-build-v1.md). Install it on the service path, create a scratch sealed key, confirm the user-presence prompt with Touch ID, read the key again and remove it.
2. Rehearse [M6-hub-migration-runbook-v1.md](M6-hub-migration-runbook-v1.md), then move the real hub and the real `tailscale serve` configuration. Do not enable Funnel. Keep both application listeners on loopback.
3. Enroll the real Mac Studio in each intended sealed pool. Verify a locked reference is opaque, an unlock prompts once, expiry locks it again, and an enrolled peer receives ciphertext.
4. Point `local_model.endpoint` at the owner’s loopback model, enable `local_model`, run `ctxd model suggest`, and inspect the proposed entries before approval.

## Unresolved findings

The SQLCipher package could not be installed because this environment cannot resolve the npm registry. `SqlCipherDatabaseProvider` fails closed with an installation error, while tests use `TestDatabaseProvider`. Before enabling sealed pools, install `better-sqlite3-multiple-ciphers@13.0.3`, record it in `package.json` and `package-lock.json`, then rerun the sealed tests against the real provider. The selected release documents macOS x64 and arm64 prebuilds for Node 22 and later.

The sealed lifecycle currently copies unlocked rows into the main database connection and moves them back on lock. That does not meet Spec 10.6’s stricter attached-file routing boundary, and queued purge records are not yet executed on unlock. Do not enable `sealed_pools` on real data until this is replaced with per-request attached-store routing and locked purge replay. This blocker prevents M6 completion.

`ctxd mirror stop` reports status but does not persistently switch the feature flag off, and archive requests do not yet have a dedicated confirmation command. Use `ctxd features set mirror off` to stop reconciliation. These two CLI gaps should be closed before treating the mirror as complete.

## Exit checks still to run

On an unrestricted scratch machine, run the exact full suite, start two loopback servers, exchange signed events, purge the signed entry, sync again and rebuild both databases. Exercise a mirror edit and stale revision conflict through the running server. After the SQLCipher blocker is fixed, repeat the sealed convergence, duplicate delivery, lock expiry and purge tests with the production database provider. Run the tool-footprint test once more after those changes.
