# Instructions for coding agents working on ctxd

## Read first

- The parent [PRD v5](docs/prd/PRD-v5.md), the latest version of each component PRD in [docs/prd/components/](docs/prd/components/) (the parent's component index lists them), and [Spec v5](docs/spec/SPEC-v5.md) are the source of truth. If code and spec disagree, raise it; do not silently diverge.
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
