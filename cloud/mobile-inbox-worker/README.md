# ctxd mobile inbox Worker

The cloud side of M7 (PRD v7 section 12; `docs/prd/components/PRD-mobile-inbox-v1.md`). A
sibling project, not part of ctxd's own npm build (see the root `tsconfig.json`'s `include`).

Deploying this is an owner step; see `wrangler.toml`'s own header for the exact commands and
`docs/build/M7-deploy-runbook-v1.md` (slice 8) for the full walkthrough, including minting and
storing tokens.

- `src/worker.ts`: the Worker itself.
- `migrations/0001_init.sql`: the D1 schema.
- `wrangler.toml`: Worker and D1 binding configuration.
- `openapi.yaml`: the client-facing capture endpoint, for a ChatGPT Action or an iOS Shortcut.
