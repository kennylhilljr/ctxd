# Claude Code MCP entry

Add ctxd once, at user scope. The entry is identical in every project and names no scope or pool; the launcher picks the session's persona from ctxd's local bindings (SPEC v5 section 8.4).

```bash
claude mcp add --scope user ctxd -- ctxd mcp --client claude-code
```

Never add ctxd to a repository's `.mcp.json`. To force a persona for one session, start Claude Code with `CTXD_POOL=<pool>` set.
