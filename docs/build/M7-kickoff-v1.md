# M7 kickoff: the mobile inbox (v1)

Instructions for the agent building ctxd M7. Read this whole file, then AGENTS.md, the parent [PRD v7](../prd/PRD-v7.md) (section 12 and FR-22), the latest component PRDs and the latest spec (Spec v9), before doing anything else.

- **Approval.** The owner approved M7 on 2026-10-19. This supersedes the line in the M3 to M6 kickoff that says M7 is not approved.
- **Builder.** This milestone is built by Gemini in Antigravity, as a comparison with the Claude Code (M1 to M5) and Codex (M6) builds. Follow the process below, not Claude Code's slash commands.

## 1. What M7 is

PRD v7 section 12: a minimal inbox in the cloud, not a mirror, so phone chats (claude.ai mobile, ChatGPT) can capture into ctxd without anything reaching into the home network.

- **Writes only land in an inbox.** Phone chats write short summaries there. The inbox never holds ctxd's store.
- **The hub empties it.** The hub pulls entries over an outbound connection, applies them, then deletes them from the inbox. Nothing ever connects into the home network, and no listener binds to anything but loopback (ADR 0003).
- **Reads are limited.** At most an allowlisted set of non-sensitive briefs is ever pushed to the cloud. This is a separate flag, default off, and may be deferred if it does not fit.
- **Phone writes are quarantined.** Everything from the inbox arrives `proposed`, labeled with its origin, for review like any other untrusted write.

## 2. Hard constraints

- **Flags, default off:** `mobile_inbox` (pulling) and `mobile_inbox.publish_briefs` (the allowlisted reads). With both off, ctxd makes no network calls for M7 and behaves exactly as M6.
- **Sealed pools never touch the inbox**, in either direction. `local-only` and `home` scopes are never published.
- **Transport is an interface.** Build the hub side against a provider-neutral `InboxTransport` with a fake transport for tests and a local-directory transport for development. The real cloud transport is one adapter behind it.
- **Delivery:** at-least-once pull, idempotent apply keyed by the entry id, delete only after the apply is durable. Property tests cover duplicates, reordering, partial failures and a crash between apply and delete.
- **Every inbox entry is untrusted input:** size limits, schema validation, the existing secret redaction before anything is stored, and access evaluation (Spec 10.5) against an inbox client identity that can only `propose` into allowlisted scopes.
- **No secrets in the repository.** The inbox token or key lives in the Keychain through ctxd's existing secret handling; tests use fakes.
- **No real project, scope or pool names** anywhere in Git (AGENTS.md).

## 3. Stop conditions (write them into the handoff and keep going with everything else)

- Choosing or creating a cloud account, DNS name, deployment or real token: the owner's step. Write the cloud adapter, its deployment files and a step-by-step deploy runbook; do not deploy.
- Anything touching the owner's real `~/.claude`, `~/.codex`, `~/.config/ctxd`, real ctxd data, launchd jobs or Tailscale configuration.
- A product decision that contradicts PRD v7.

## 4. Plan first

Write `docs/build/M7-plan-v1.md` as the first commit after this file. It must include:

- the slice list;
- a recommendation, with tradeoffs, for the cloud side (for example a small serverless worker with a database, or a remote MCP endpoint that the phone apps can add as a connector), judged on: no inbound path home, write-only exposure, cost, and what the phone apps can actually reach;
- the threat model for the inbox (stolen token, flooding, prompt injection in captured text, replay).

## 5. Docs

- New component PRD `docs/prd/components/PRD-mobile-inbox-v1.md` (requirement ids `MI-`), referencing the parent and its siblings.
- Spec changes collect into Spec v10 at the milestone end. Never edit a past version.
- Prose style: no em dashes, en dashes or double hyphens.

## 6. Process

- Work on branch `m7/gemini` only. One commit per slice, message starting `M7 slice N:`. Do not push and do not open PRs; the owner reviews the branch.
- For each slice: `npm run typecheck`, `npm test`, then review your own diff for simplicity and correctness before committing.
- Commits use the git identity already configured on the machine (AGENTS.md); credit yourself with a `Co-Authored-By:` trailer.

## 7. Exit

- With the flag on and the fake or local-directory transport, entries are pulled, applied as `proposed` in the right scope with their origin, and deleted from the inbox; with the flag off, no network calls.
- The idempotency and crash property tests pass.
- The cloud adapter, its deployment files and the owner runbook are written, and `docs/build/M7-handoff-v1.md` lists the owner's steps.
