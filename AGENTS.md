# Instructions for coding agents working on ctxd

## Read first

- The parent [PRD v6](docs/prd/PRD-v6.md), the latest version of each component PRD in [docs/prd/components/](docs/prd/components/) (the parent's component index lists them), and [Spec v6](docs/spec/SPEC-v6.md) are the source of truth. If code and spec disagree, raise it; do not silently diverge.
- Component PRDs reference their parent, their siblings and the spec sections that implement them. Keep those references current when adding or versioning a document. Links inside an unchanged component may point to sibling versions current when it was written; the parent PRD's component index is authoritative.
- Use the latest numbered version of each document. Never edit a past version; create the next numbered file instead.

## Rules

- **Loopback only.** Never bind a listener to anything other than loopback, and never add Tailscale Funnel or any public tunnel (ADR 0003).
- **Hooks never break a session.** Hook code paths exit 0 except an intentional Stop block (SPEC 9.1).
- **Keep the tool surface small.** Tool descriptions stay terse, and the footprint test must pass (PRD NFR-4).
- **The event log is the source of truth.** Never mutate materialized state without an event (ADR 0002).
- **Sync changes ship with tests.** Every change to sync or apply comes with property tests for convergence.
- **No secrets in fixtures or docs.**
- **No real project, scope or pool names anywhere in the repository** (docs, examples, tests, fixtures, commit messages). Use invented examples such as `sample-app`, `notes`, `project-b`, `shared-tools`, `pool-dev`, `pool-notes`, `pool-ops`, `pool-private`, `private-a`. The owner's real names live only in ctxd's local data, never in Git. This rule overrides "never edit a past version" when sanitizing.
- **Access is default deny.** Every new tool or command goes through the access evaluation in Spec 10.5; agents never get human-only operations.
- **Purge is the only history rewrite.** Nothing else may modify stored events (Spec 7.6.6).
- **Writing style for docs:** no em dashes, en dashes or double hyphens in prose; use commas, colons, semicolons, periods or parentheses.

## Commands

```bash
npm run typecheck
npm test
```

## Built-in skills to use while building (Claude Code)

These are Claude Code's built-in slash-command skills. Use them as part of every change, in this order. They are required, not optional; skip one only when its trigger does not apply, and say so in the handoff.

| When | Skill | What it is for here |
|---|---|---|
| Once, as soon as `ctxd server` and the CLI can start (M1), and again whenever the build or launch steps change | `/run-skill-generator` | Teaches `/run` and `/verify` how to build and launch ctxd: `npm run build`, a temporary data directory, `ctxd init`, `ctxd server` on loopback, then CLI and MCP calls against it |
| While developing anything you can observe running (server, CLI, hooks, MCP tools, mirror, skill sync) | `/run` | Launch ctxd and drive it to watch the change live, for example a SessionStart hook printing a brief, or `ctxd tree ctxd://_me` |
| After the change works, before review | `/simplify` | Remove unnecessary complexity in the changed code; keep behavior and tests unchanged |
| After `npm run typecheck` and `npm test` pass | `/verify` | Build and run ctxd to confirm the change actually works end to end, not only that tests and types pass. For hooks, replay a conformance fixture through the real `ctxd hook` binary |
| Before every commit or pull request | `/code-review` | Audit the diff for bugs, logic errors and best practice, and check it against this file's rules (loopback only, hooks exit 0, events as source of truth, default-deny access, footprint budget, no real names) |
| For iterative checks: repeated property-test runs, watching CI, or re-running verification until a fix holds | `/loop` | Run the check on a cadence until it passes or a limit is reached; stop the loop when done |
| Whenever code calls the Anthropic API or SDK (none is planned before M6; ctxd's own model features use a local model) | `/claude-api` | Write and integrate that code correctly |
| When dynamic workflows are enabled and a task splits across agents (for example parallel component work in separate worktrees) | `/workflow-authoring` | Author the multi-agent workflow instead of improvising one |

**Definition of done for a change:** typecheck and tests pass, `/simplify` applied, `/verify` confirms the behavior, `/code-review` finds nothing unresolved, docs and spec references updated, and a handoff written.

Codex and other agents without these skills follow the same steps by hand: run the app to observe the change, simplify, verify end to end, and review the diff against the rules above before committing.
