# ADR 0004: Embedding vectors replicate as event data; a weak or temporary hub need not compute them

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR 0002](0002-event-log-sync.md)'s "State is derived... vectors are materialized locally and can be rebuilt," for embedding vectors only. FTS5 search indexes are unaffected: they stay purely derived, never replicated, exactly as ADR 0002 already decided.

## Context

M5 adds semantic search (PRD-v7 section 10, FR-20): a local embedding model blended with full-text
ranking via `sqlite-vec`. ADR 0002 treated vectors the same as FTS: a materialized, locally
rebuildable view of the event log, never itself replicated.

The real machines this runs on make that unworkable as a blanket rule. The current hub is a
temporary Intel MacBook Air (PRD-replication section 2), on its way to macOS end of life, with no
Apple Silicon Neural Engine and limited CPU headroom; running an embedding model there for every
write, on every machine's behalf, is not realistic. It will eventually be replaced by a Mac
Studio, which the PRD already names as adding "a local model," but until then the hub's job is
staying on and serving, not computing. Meanwhile, the daily-driver machine (`roaming` in the
replication PRD's machine table) already runs Claude Code and Codex sessions that could do this
work at write time, where the machine is already active and a few hundred milliseconds of
embedding time is invisible.

## Decision

- **Embeddings are computed once, by whichever machine has the `semantic_search.compute` flag on
  for the entry revision being written**, using a small, fixed, CPU-friendly local model (no GPU
  or Neural Engine assumed). The flag defaults off everywhere, per the existing feature-flag rule
  that anything needing hardware ships off by default; a capable machine turns it on deliberately.
- **The resulting vector replicates as ordinary event data**, tagged with the model's id and
  dimension, exactly like any other part of an entry. A machine that receives it through sync has
  it without ever running the model itself.
- **Serving hybrid search needs only `sqlite-vec` loaded and whatever vectors have already
  arrived.** A machine with `semantic_search.compute` off can still serve search blended with
  vectors other machines computed; it just never produces new ones itself. This is what lets the
  Intel Air hub serve search today without the model it cannot run well, and the eventual Mac
  Studio hub to take over computing once it arrives, exactly as the replication PRD's "moving the
  hub" section already anticipated for the model generally.
- **A revision with no vector yet** (no `semantic_search.compute` machine has processed it) is not
  an error. Search for it falls back to full-text only, the same graceful degradation
  `semantic_search` off already has everywhere.
- **FTS5 indexes are untouched by this ADR.** They remain purely local and derived, per ADR 0002,
  since recomputing them is cheap everywhere and they carry no meaning across machines the way a
  specific embedding model's vector space does.

## Consequences

- The event log gains one more kind of payload (an embedding vector plus its model id and
  dimension), carried the same way any other part is: through the existing sync protocol, under
  the same per-scope replication policy (`all`/`home`/`local`) the entry itself already has.
- A model change is a visible, detectable event: vectors tag their own model id and dimension, so
  a future model swap can distinguish old vectors from new rather than silently mixing
  incompatible vector spaces in one `sqlite-vec` table.
- This does not change who may read what. Vector payloads replicate under the same scope
  replication and vendor policy as the entry they describe; a `local-only` or sealed scope's
  vectors are exactly as restricted as its text.
- Compute cost moves to write time on whichever machine has the flag on, not to a central indexer.
  A machine that writes a great deal with the flag on pays that cost locally; a machine that never
  turns it on never pays it and never blocks on it.
