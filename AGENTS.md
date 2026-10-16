# Instructions for coding agents working on ctxd

## Read first

- [PRD v1](docs/prd/PRD-v1.md) and [Spec v1](docs/spec/SPEC-v1.md) are the source of truth. If code and spec disagree, raise it; do not silently diverge.
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
