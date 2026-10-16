# ADR 0003: No public network endpoint

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Remote MCP clients such as claude.ai web and mobile, and ChatGPT, connect from vendor clouds and would require a public HTTPS endpoint with OAuth. Even with IP allowlisting, that exposes my personal knowledge base to the internet.

## Decision

- **MCP listens on `127.0.0.1` only.**
- **Sync is reachable only on my tailnet,** via `tailscale serve`, restricted by Tailscale ACLs.
- **No public exposure of any kind.** Tailscale Funnel, Cloudflare Tunnel and similar public exposure are prohibited.
- **Enforced at startup.** The server refuses to start if a listener is bound to a non-loopback address.

## Consequences

- claude.ai web and mobile, and ChatGPT, are not live clients in v1. Phone access is through SSH over Tailscale to a Mac running Claude Code or Codex.
- If phone-chat capture becomes important, a separate minimal inbox (PRD section 12) can be considered. It would be a new ADR, with writes quarantined and no full mirror.
- Data still reaches model providers inside prompts. That is addressed by scope vendor policies, not by network design.
