# Instructions for coding agents working on ctxd

## Read first

- The parent [PRD v3](docs/prd/PRD-v3.md), the latest version of each component PRD in [docs/prd/components/](docs/prd/components/), and [Spec v3](docs/spec/SPEC-v3.md) are the source of truth. If code and spec disagree, raise it; do not silently diverge.
- Component PRDs reference their parent, their siblings and the spec sections that implement them. Keep those references current when adding or versioning a document.
- Use the latest numbered version of each document. Never edit a past version; create the next numbered file instead.

## Rules

- **Loopback only.** Never bind a listener to anything other than loopback, and never add Tailscale Funnel or any public tunnel (ADR 0003).
- **Hooks never break a session.** Hook code paths exit 0 except an intentional Stop block (SPEC 9.1).
- **Keep the tool surface small.** Tool descriptions stay terse, and the footprint test must pass (PRD NFR-4).
- **The event log is the source of truth.** Never mutate materialized state without an event (ADR 0002).
- **Sync changes ship with tests.** Every change to sync or apply comes with property tests for convergence.
- **No secrets in fixtures or docs.**
- **Writing style for docs:** no em dashes, en dashes or double hyphens in prose; use commas, colons, semicolons, periods or parentheses.

## Commands

```bash
npm run typecheck
npm test
```
