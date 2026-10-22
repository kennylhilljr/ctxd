# W10 handoff v1: entries.origin, provenance as a column

The third of [W7's](W7-plan-v1.md) approved follow-ups ("a generic provenance column on
`entries`"), approved by the owner on 2026-10-21.

## Commits

- `5b20bf8` `W10 slice 1: entries.origin, provenance as a column instead of tags`
- this handoff

Branch `done/w10-entry-origin`, based on `main` after W1 to W7 had all merged.

**Schema version 23.** If another branch also bumps the schema, whichever merges second
renumbers, per the completion kickoff's own rule.

## Delivered

**`entries.origin`**: canonical JSON `{source, captured_at?, client_ref?}`, written at create and
never changed by a later update, NULL for an ordinary write (which `created_by` already explains).
Migration 22 to 23 is a plain `ALTER TABLE ... ADD COLUMN`, so existing entries simply read NULL.

**Set only by a trusted internal caller**, through a new optional `WriteContext.origin`, and
deliberately *not* added to `contextWriteInput`. Two reasons, both load-bearing: provenance a
writer can claim for itself is worth nothing, and the MCP tool surface stays exactly as it was, so
the footprint budget (NFR-4) is untouched.

**It replicates and rebuilds for free**, because it rides in the create event's payload rather
than being a side table: `src/sync/apply.ts` and `ctxd rebuild` both replay create events through
the same materializer.

**One real finding along the way.** The column is written with `canonicalJson`, not plain
`JSON.stringify`. The stored event payload is already canonical (key-sorted), so a live write that
serialized in insertion order produced a *different string* from the same entry replayed from the
log. Content was identical, bytes were not, which would make any `SELECT *` state comparison
(`dumpHash` in the write tests, and anything else comparing a rebuild against live state) report
drift that is not there. The rebuild test caught it; the fix is one call, and the test now guards
it.

**The mobile inbox stops abusing `tags`.** It previously wrote `origin:mobile-inbox`,
`captured:<ts>` and `ref:<id>` into the entry's tags, which both polluted the entry's own tags and
made provenance compete with them for the ten tag slots. Declared tags now pass through untouched.
`ctxd show` prints an `origin:` line when the column is set, so the facts are still visible to a
human; nothing else reads it yet, and `ENTRY_COLUMNS` is unchanged, so no brief or search query
pays for the column.

Docs: the column and its rationale in [LLD: Data model](../lld/LLD-data-model-v1.md) 4 (schema copy
now says version 23), the inbox's own provenance section rewritten in
[LLD: Mobile inbox](../lld/LLD-mobile-inbox-v1.md) 17.3, and `MI-AC-7` moved from Partial to
Covered in the [test plan](../test/test-plan-v1.md). No new acceptance criterion was needed:
`MI-AC-7` already required recording source, capture time and reference, and this is what finally
satisfies all three.

## Verification

`npm run typecheck`, `npm run build` and `npm test`: 866 of 866 tests passing across 81 files
(the count rose after rebasing onto a `main` that had taken W8 and W9, plus the two review fixes
above). New or changed:

- `db.test.ts`: a 22 to 23 migration test (an entry written before the column reads NULL after
  migrating), plus the three existing simulated-old-version tests extended to drop the new column
  during rollback, the same way they already drop W2's and W3's tables.
- `write.test.ts`: provenance survives `ctxd rebuild` (the finding above), is NULL for an ordinary
  write, and is left alone by a later update whose context carries no origin.
- `inbox-pull.test.ts`: the old "tagged with its origin" assertion is now an `entries.origin`
  assertion that also checks declared tags are no longer rewritten, plus a case where the capture
  gave no `client_ref`.

Live, against a scratch `ctxd init` instance: captured an entry through the local transport with a
tag and a `clientRef`, ran `ctxd inbox pull`, and `ctxd show` printed
`origin: via mobile-inbox, captured 2026-10-21T09:30:00.000Z, ref msg_123` with `tags: errand`
intact.

## Added after review

Two further defects came out of the review of this PR, both fixed on this branch:

- **Purge did not clear `entries.origin`.** The purge stub's `ON CONFLICT ... DO UPDATE` reset
  title, summary, body and tags but not the new column, while its `INSERT` never set it. So a
  live purge kept the provenance ("captured from this phone at this time, their ref `msg_123`")
  and a rebuild dropped it, which is both a leak of exactly the trail purge exists to remove and a
  divergence between the live path and the replay, the very thing that handler's own comment warns
  against. Fixed with `origin = NULL`, and covered two ways: a test asserting NULL live *and*
  after a rebuild, and provenance added to the purge-replay property test so its state-hash
  comparison catches it. Both fail without the fix; I checked by reverting it.
- **Sealed pool files were never migrated.** A sealed file got its schema once, at creation, and
  `openDatabase`'s migration chain only ever ran against the main database. So a pool sealed
  before any schema bump stayed at its old version forever, and the first write needing a newly
  added column failed *inside the encrypted file* with `table entries has no column named
  origin`. This was a latent architectural gap that `entries.origin` happened to expose; it would
  have bitten the next schema change regardless. The chain is now `migrateSchema` in
  `src/store/db.ts`, called by `openDatabase` and by both sealed database providers on open. The
  test writes into a sealed file rolled back to schema 22, and failed exactly as predicted before
  the fix.

## What was not done and why

- **No backfill of existing inbox entries.** Entries already applied with the old tag convention
  keep their `origin:`/`captured:`/`ref:` tags and have a NULL column; rewriting them would mean
  mutating materialized state without an event (ADR 0002). If you have any such entries and want
  them converted, say so and it becomes a small purpose-built migration, not a silent one.
- **Nothing reads it besides `ctxd show`.** Briefs, search and the MCP tools ignore the column on
  purpose: adding it to `ENTRY_COLUMNS` would put provenance into every brief's token budget for
  no stated requirement. Easy to add later for a specific need.
- **No new PRD requirement.** The column is deliberately general, but it has exactly one producer
  today, and `MI-8`/`MI-AC-7` already drive it. Inventing a knowledge-model requirement for a
  hypothetical second producer would be speculative; the W7 plan's reasoning was "if a second
  untrusted-input integration lands", and that is still a conditional.

## Owner steps

1. Merge whenever. If another schema-bumping branch lands first, renumber this one's migration.
2. Nothing to configure: the column is always present and always NULL unless an inbox capture
   wrote the entry.
