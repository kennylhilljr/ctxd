# M6 build plan v1

This plan covers M6 only, as defined by section 4 of `docs/build/M3-M6-kickoff-v1.md`.
Work stays on `m6/codex`. Each slice ends with `npm run typecheck`, `npm test`, a live check
against scratch configuration and data directories, a simplification pass, a review of the slice
diff, and one commit whose subject begins `M6 slice N:`. Nothing is pushed and no pull request is
opened.

## Source of truth

Implementation follows PRD v7, the component versions indexed by PRD v7, and Spec v8. M6 will
produce Spec v9 by copying Spec v8 and replacing the M6 placeholders with the behavior that ships.
Past numbered documents remain unchanged. A component PRD will receive a new numbered version only
if implementation requires a product behavior change.

The M5 handoff lists unfinished M5 work. Those items remain outside this run because the request is
M6 only. Any M5 defect that directly prevents M6 will be recorded in the M6 handoff under the stop
rules below.

## Slice 1: signed events and Spec v9

Add one Ed25519 key pair per node through a testable key provider. Store the public key in node
metadata and keep private key material outside the event database. Define a canonical event payload
hash, sign that hash when `signed_events` is on, and verify every existing signature during local
rebuild and replication apply even when the flag is off. Purge may erase payload and prior values,
but it must retain the signed payload hash and signature so verification still succeeds.

Add schema migration, rebuild, sync, tamper, missing key, flag off, and purge coverage. Verify two
scratch servers exchange and validate signed events, then purge one of those entries and validate it
again. Create Spec v9 in this slice with the final signed event format and the remaining M6 designs.

## Slice 2: Markdown export, mirror, and import

Implement `ctxd export --markdown`, `ctxd mirror start|stop|status`, `ctxd open`, and
`ctxd import`. Export and mirror files use the Spec 12.1 frontmatter and stable `ctxd://` paths.
Mirror writes are atomic. Imported and edited text goes through the normal sanitizer and event write
path. Revision mismatches create conflict copies and review items. File deletion creates an archive
request and restores the source file until a human confirms it. Sealed scopes are excluded from
export and mirror output.

The mirror remains inert while its flag is off and catches up when enabled again. Tests use only a
temporary data directory and temporary import folders. Live verification will export entries, edit
one mirrored file, exercise a stale revision conflict, import a new file, and confirm event history
for successful writes.

## Slice 3: sealed pools

Use `better-sqlite3-multiple-ciphers` with its SQLCipher compatibility mode. It matches the existing
`better-sqlite3` API and current major version, and its Node 22 packages provide macOS x64 and arm64
prebuilt binaries. Define a database adapter boundary so ordinary and encrypted stores share schema
and query code.

Implement `ctxd pool seal`, `enroll`, and `lock`, separate encrypted files named by internal pool id,
attach and detach routing, the unlock window, enrolled node filtering, authenticated encryption for
replicated sealed events, and queued purge until unlock. Tests use an in memory test key provider and
never touch the real Keychain. Property tests cover sealed sync convergence, enrollment filtering,
delivery order, duplicate delivery, purge, and lock or unlock transitions.

Add the macOS `ctxd-keyhelper` source and reproducible build instructions. The helper will request a
user presence protected Keychain item through LocalAuthentication. Code signing, installation,
Touch ID, real Keychain access, and real hardware verification remain owner steps.

## Slice 4: hub adoption and migration runbook

Implement `ctxd node adopt` so a copied data directory can take a new node name while preserving the
node id. The command must refuse unsafe states, including a running server, an uninitialized data
directory, or an identity collision. No command will change Tailscale configuration.

Write the Mac Studio migration runbook with dry run commands for copying data and configuration,
adopting the node, moving tailnet only `tailscale serve` configuration, updating peer URLs, checking
signatures and sealed pool enrollment, and rolling back to the stopped old hub. Tests and live checks
use two scratch nodes and temporary directories.

## Slice 5: local model proposals and M6 exit

Add a localhost only local model adapter for optional summaries and lesson suggestions. The
`local_model` flag is off by default. Model output is always stored as `proposed`, carries a
machine written label and provenance, and passes through the same sanitizer and access evaluation as
other writes. Model failure leaves deterministic summaries unchanged and does not block hooks or
ordinary writes.

Use a fake local model in tests. Live verification uses a scratch localhost fixture, not a real
model. Run the full M6 exit checks: signed events across two servers after purge, mirror edit round
trip with revision conflicts, sealed pool convergence with the test key provider, feature off paths,
tool footprint, typecheck, tests, and build. Write `docs/build/M6-handoff-v1.md` with exact owner
commands for code signing and Touch ID, Mac Studio migration, real sealed enrollment, and a real
local model run.

## Stop rules

The run stops only when work would touch real user configuration or data, real launchd jobs, real
Tailscale settings, owner hardware or identity, an irreversible operation, or a product decision
that contradicts PRD v7. A blocked question goes into `docs/build/M6-handoff-v1.md`. Work continues
on every independent slice before stopping.
