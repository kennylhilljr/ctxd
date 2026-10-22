# W7 plan v1: new features

Per [completion-kickoff-v1.md](completion-kickoff-v1.md) section 1, W7: plans only, for the
owner's approval, before anything here is built.

## 1. Agent team memory

**What this is.** The owner's orchestrator (`coordinate-agents`, a separate repository;
[PRD-v7](../prd/PRD-v7.md) Appendix B) runs agents in planner, implementer and reviewer roles
against task graphs, in its own `.agent-bus/` plaintext files, one repository at a time. It has
no durable, cross-repository memory of its own. The idea: after each run, it writes that run's
outcome, review findings and lessons into ctxd as `proposed` entries in one scope, so every agent
on the team (not just the one that happened to work on that repository) sees what the team
learned.

**ctxd's side only; the orchestrator side is its own kickoff.** The kickoff asks ctxd's side to
confirm, not build, the write path, access grant and kinds needed. Confirmed:

- **Write path.** Nothing new. The orchestrator is a client like any other, over MCP's
  `context_write` or (if it runs outside any single agent's session) the CLI equivalent. The
  existing single write path (Spec v10 section 6) already does everything this needs: redaction,
  access evaluation, and forcing agent writes to `proposed` for review before anyone treats a
  lesson as settled.
- **Kinds needed.** Already exist, no new kind required: `fact` (what happened), `lesson` (what
  to do differently), `decision` (if the run made one worth recording), `journal` (a routine
  per-run log entry, significance `routine` or `incident`). All four already default to
  `proposed` for agent writes (`src/core/kinds.ts`'s `DEFAULT_AGENT_STATUS`), and `preference` and
  `skill` are deliberately excluded from this (10.4: never auto-accepted, always human-reviewed,
  which is correct for anything written by an automated orchestrator rather than a person).
- **Access grant.** A new invented-name scope, for example `team-memory`, in a pool the
  orchestrator client belongs to, granted `propose` (never `write`): this is the W1 inbox's own
  recipe (`ctxd client add coordinate-agents --vendor local`, `ctxd pool create <pool>`, `ctxd
  pool add-member <pool> coordinate-agents`, `ctxd pool grant <pool> team-memory --level
  propose`), not new ctxd mechanism. `propose`, not `write`, matters here for the same reason it
  matters for the mobile inbox: an automated process's output stays reviewable before it is
  treated as team knowledge, not applied silently.
- **What ctxd does not need to add.** No new scope kind, no new access-control concept, no schema
  change. This is confirmation, not a gap: the orchestrator writing to ctxd is exactly the same
  shape of integration the mobile inbox (W1) just proved out for an even less trusted source
  (an anonymous phone client, versus the owner's own orchestrator running locally).

**Owner's decision needed:** the scope name (an invented one, per AGENTS.md; `team-memory` above
is a placeholder) and which pool(s) see it. Everything else is ready today, with existing `ctxd
client add` / `ctxd pool` commands; no ctxd code change is proposed for this item.

## 2. Anything else found while doing W1 to W6

Listed with a reason, not built. Only items this agent actually found while building; nothing
here is proposed for W7 itself unless the owner asks for it.

- **Scheduling `ctxd inbox pull`** (W1). The mobile inbox pulls only when run by hand; nothing
  runs it on an interval the way `sync` or `digest` do inside `ctxd server`, or the way W4 built a
  dedicated `ctxd backup schedule` launchd installer. Not built in W1 because M7's own slice list
  asked only for the CLI subcommands. If scheduled inbox pulls turn out to be the common case
  (likely, once a real phone app is connected), a `ctxd inbox pull schedule` installer mirroring
  `src/cli/backup-schedule.ts` is the natural next slice.
- **A shared scheduling abstraction.** W4's backup scheduler and the above (not yet built) inbox
  scheduler would be two near-identical launchd-plist installers. Not generalized now: only one
  concrete instance exists today, and extracting a shared abstraction from a single example risks
  guessing the wrong shape. Worth revisiting once a second real instance exists.
- **`ctxd pool rekey <pool>`** (W2). Revoking a node from a sealed pool does not re-key the pool;
  a since-revoked node keeps whatever key it already received. This was an explicit, documented
  design decision (D3, "no re-key"), not an oversight, but re-keying is still a real operation a
  determined owner might eventually want (for example, after a real security incident rather than
  routine offboarding). Not built: materially heavier than key transfer itself (decrypt and
  re-encrypt the sealed file, re-wrap for every remaining node), and nothing in this run's scope
  asked for it.
- **A generic provenance column on `entries`.** The mobile inbox's provenance (client, capture
  time, external reference; MI-8) had to be carried as tags, since `entries` has no generic
  metadata column for "where this really came from" beyond `created_by`. Tags work today and this
  is not urgent, but if a second untrusted-input integration lands (for example, the agent team
  memory above, or anything else that writes on another system's behalf), a real column might be
  worth it rather than a second ad hoc tag convention. Not proposed now: one example does not
  justify a schema change.
- **Hybrid search tuning after real use** (W6). The benchmark shows hybrid clearly beating
  keyword-only, including on paraphrase queries, so no tuning was needed to ship it. The W6
  handoff's own exit note already flags this as something to revisit after real usage, not
  something this run found newly.

## Owner's decision

Approve item 1 (confirmed design, no code to review beyond what client/pool/scope names to use)
and say which of item 2's items, if any, should become their own workstream. Nothing in this
document has been built.
