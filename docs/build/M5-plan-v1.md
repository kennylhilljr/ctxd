# M5 plan v1

Written per `docs/build/M3-M6-kickoff-v1.md` section 2, in M5's first PR, the way M3 and M4's own
plans were written in theirs. PRD-v7's M5 row: "Semantic search, Desktop chat integration, scope
rollback, review-by dates and `ctxd tidy`, importance ranking, weekly digests, native skill
sync." Exit criterion: "Hybrid search measurably better on a test set."

## Resolving the milestone's own blocker first

Semantic search is the one M5 feature with a real blocker baked into the PRD: open questions Q1
(hub hardware) and Q5 (embedding model choice) were both unresolved, and either one gates the
headline feature. The owner answered both directly: the hub is a temporary Intel MacBook Air,
replaced later by a Mac Studio, and the embedding approach is a small, CPU-friendly local model.
The owner then gave a more specific architecture on top of that: compute embeddings on client
machines, replicate the resulting vectors, and let the hub store and serve hybrid search without
ever running the model itself.

That last part reverses a standing decision, not just fills in a blank: `PRD-replication-v4`
section 3 said "search indexes and embeddings never replicate; each machine rebuilds its own," and
[ADR 0002](../adr/0002-event-log-sync.md) said the same ("vectors are materialized locally and can
be rebuilt"). Both were written before M5 had a real architecture to test that blanket rule
against. Rather than silently diverge, this is recorded as an explicit reversal, limited to
embeddings only (FTS keeps the old rule unchanged, since it is genuinely cheap to rebuild and
carries no cross-machine meaning):

- [ADR 0004](../adr/0004-embeddings-replicate.md), new, amending ADR 0002 for embeddings only.
- [PRD-replication-v5](../prd/components/PRD-replication-v5.md), superseding v4: machines and
  roles table updated, the replication rule split (FTS never replicates; embeddings now do), new
  requirements RP-16/RP-17, RQ-3 resolved.
- `PRD-v7.md`: Q1 and Q5 marked resolved, pointing to the above; its component index bumped to
  point at replication v5.
- `SPEC-v8.md` section 11.2's own long-standing "M5: hybrid with sqlite-vec... via reciprocal rank
  fusion" placeholder filled in, plus a new section 11.2.1 (the `embedding` event part, the
  `embeddings` table, materialization, purge, access) and the `events.part` CHECK extended.
- Two new feature flags, registered for real in `src/config/flags.ts`: `semantic_search` (serving;
  default off) and its child `semantic_search.compute` (whether this machine computes and
  contributes vectors at all; default off, since it needs hardware, same rule every other
  hardware-dependent flag in this registry already follows).

One real gap noted while doing this, unrelated to M5 but found along the way: PRD-feature-flags-v1's
table says `backups` and `backups.copy` (M4) default off, but the shipped code (M4 slice 3)
defaults both to on. Flagged here rather than fixed unilaterally, since changing a shipped
default is a product decision, not a documentation typo to silently correct either direction.

## Slices

| # | Slice | What it needs | Depends on |
|---|---|---|---|
| 1 | Embeddings architecture: spec, ADR, flags | Done above; this document | none |
| 2 | `ctxd stdio` (Desktop chat integration, SPEC 9.6) | Stdio-to-HTTP MCP proxy; `deploy/clients/claude-desktop-config.json` already names it | none |
| 3 | Importance ranking (SPEC 11.3) | The formula is fully specified; wire it into brief ranking and search ranking behind the `importance` flag | none |
| 4 | Review-by dates and `ctxd tidy` (SPEC 7.6.7, Knowledge model 3.1) | Per-kind review-by defaults (check what M1 already stores); `ctxd tidy`'s proposals, confirmed only | 3 (tidy's threshold reads importance) |
| 5 | Scope rollback (SPEC 7.6.5) | `ctxd scope rollback <scope> --to <time>`, a rollback batch reusing 7.6.2/7.6.3's quarantine-and-revert machinery, preview plus confirmation | none |
| 6 | Weekly digest (SPEC 11.5) | `journal.digest_node`/`digest_weekday` config, the idempotent per-week `digest:<scope_id>:<ISO week>` request id, `ctxd digest` | none |
| 7 | Native skill sync (SPEC 12.2) | The `skill_syncs` table and `[skills]` config key already exist (M1 schema); writing real client skill files is new | none |
| 8 | Semantic search: embeddings end to end | Schema migration (`embeddings` table, `events.part` gains `embedding`), compute on write behind `semantic_search.compute` (a small ONNX/WASM model, no native build step, so it runs on any machine including the Intel hub if ever turned on there), `sqlite-vec` loaded for storage and query, reciprocal rank fusion in search ranking | 1; likely the slice most worth splitting further once underway, the way M4 slice 7 was its own careful pass |
| 9 | Handoff | Exit check, what landed, known gaps | all of the above |

Slices 2 through 7 do not depend on each other and could in principle run in parallel, but this
build follows M3 and M4's own practice of a single sequential chain per milestone rather than
parallel agents, for the same reason: conflict risk in the shared files (`src/cli/index.ts`'s
command registry, `src/store/schema.ts` for anything touching storage) outweighs the parallelism
gained for work this size. Slice 8 is sequenced last deliberately: it is the only slice that
touches `src/store/schema.ts` and the sync/apply path, the highest-risk files in this build, the
same reasoning M4 used to put its own schema-adjacent slice (detached workers) last.

## Definition of done per slice

Unchanged from M1 through M4: typecheck and tests pass, a live check against the real built CLI
(scratch config/data directories only; never real `~/.config/ctxd`, real launchd jobs or real
Tailscale configuration), a self-review of the diff, then a commit, push and PR with the
verification written into its description.

## Exit

Per PRD-v7: "Hybrid search measurably better on a test set." A small, fixed test set of entries
and queries, compared FTS-only vs. hybrid, with a concrete, written-down metric (recall@k or a
simple relevance judgment) rather than an impression. The other six features each have their own
SPEC acceptance criteria already listed in their respective sections.
