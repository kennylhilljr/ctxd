# ctxd Contract: CLI Reference (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 contract (external surface) |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 13 |
| **Owner** | A by persona `component-designer`; human review at Gate 3 for human-only commands |
| **Executable source** | `src/cli/` |
| **Moved from** | Spec v9 section 13; Spec v10 draft W2 (`ctxd pool approve-key-transfer`) |

Commands marked human only are refused for agent clients (access evaluation, [LLD: Security and access](../lld/LLD-security-access-v1.md) 10.5).

## 13. CLI reference

| Command | Purpose |
|---|---|
| `ctxd init` | Create config, data dir, node identity, `human` client |
| `ctxd server` | Run the server (used by launchd) |
| `ctxd stdio --client <name>` | MCP stdio proxy for Desktop |
| `ctxd hook <event> --client <name>` | Hook entry point |
| `ctxd scope add <name> [--replication ...] [--vendor-policy ...]` | Manage scopes |
| `ctxd client add <name> --vendor <v> [--scopes a,b] [--access read\|write]` / `revoke` | Manage client tokens |
| `ctxd node add-peer <name> <url>` / `revoke` | Manage peers |
| `ctxd sync [--peer <name>]` | Pull now |
| `ctxd brief <scope> [--size ...]` | Print a brief |
| `ctxd review` | Interactive queue: proposed, conflicted, auto-resolved, drift, takeovers |
| `ctxd claims [<scope>]` | List claims with state, paths, overlaps and drift |
| `ctxd scope bind <scope> --repo <normalized origin>` / `unbind` | Bind a repository identity to a scope |
| `ctxd history <ref>` | Every change to an entry with part, author, machine, prior and new values |
| `ctxd show <ref> [--at <time>] [--why]` | An entry now, or as it was at a point in time; `--why` explains its importance (11.3) |
| `ctxd status` / `ctxd statusline` | Health, scope, claims, sync; one-line form for the Claude Code status line |
| `ctxd worker <ticket>` | Internal: detached hook work (9.7) |
| `ctxd pool create\|show\|grant\|revoke\|add-member\|remove-member ...` | Persona pools (PRD-pools-access section 8) |
| `ctxd client tag <client> <tag>` | Tag an agent for pool membership |
| `ctxd grant <client> <scope> --level <l> --for <duration>` | Temporary grant |
| `ctxd access <client>` | Effective access per scope and the reason for each |
| `ctxd hold list\|show\|promote\|discard\|adopt ...` | Holding scopes and access requests |
| `ctxd flag <ref> --problem <p> --reason <text>` / `unflag <ref>` | Flag or clear |
| `ctxd quarantine --client\|--session ... [--since] [--until] [--scope]` | Open a quarantine batch |
| `ctxd batch show <id>` / `revert <id> [--entry <ref>]` / `release <id> [--entry <ref>]` | Inspect and resolve batches |
| `ctxd scope rollback <scope> --to <time>` | Roll a scope back (with preview) |
| `ctxd purge <ref> --reason <text> [--rewrite-backups]` | Erase content everywhere |
| `ctxd tidy` | Interactive cleanup suggestions |
| `ctxd mcp --client <id>` | Stdio MCP launcher (8.4); the only MCP entry each agent needs |
| `ctxd persona issue\|rotate\|revoke <client> <pool>[,<pool>]` | Persona tokens (secrets go to the Keychain) |
| `ctxd persona prefer <client> <scope> <pool>` | Resolve multi-pool ambiguity for a scope |
| `ctxd pool seal\|enroll\|lock <pool> [<node>]` | Sealed pools (10.6) |
| `ctxd pool approve-key-transfer <transferId>` | Human only, on the source node: approve a pending sealed key transfer and print its confirmation code (10.6.1); needs `sealed_pools.key_transfer` |
| `ctxd scope set <name> --intent-policy <observe\|warn\|strict>` | Set a scope's overlap policy |
| `ctxd export --markdown <dir>` | Human-readable export. Passes all text through the 6.1 pipeline in redact-in-place mode, then prints warnings by category (possible secret, home-directory path, email or phone pattern) and asks for confirmation before writing |
| `ctxd ls <path> [--all]` / `tree <path> [-L <n>]` / `read <path>` | Browse the filesystem view (4.2) |
| `ctxd grep <pattern> [<path>]` | Full-text search within a subtree |
| `ctxd open <path>` | Open the entry's mirror file in `$EDITOR` |
| `ctxd mirror start\|stop\|status` | Markdown mirror (12.1) |
| `ctxd import <dir> --scope <name> [--dry-run]` | Import Markdown files as proposed entries (12.1) |
| `ctxd skills list\|show <name>\|sync [--client <id>]\|import --from <client>` | Skills (4.3, 12.2) |
| `ctxd remember "<text>" [--kind preference\|convention\|fact] [--scope _me]` | Record memory directly as the human client |
| `ctxd log "<text>" [--significance <s>] [--scope <name>] [--resolves <ref>]` | Add a journal entry |
| `ctxd journal [<scope>] [--day <date>\|--since <age>]` | Read the journal; `ctxd digest [<scope>] [--week <id>]` prints or writes a digest (11.5) |
| `ctxd signals [<scope>]` | Open signals with their age (11.4) |
| `ctxd stats [--since <age>]` | Response metering (8.5) |
| `ctxd backup` / `restore <file>` | Backups |
| `ctxd rebuild` | Rebuild materialized state and FTS from the event log |
| `ctxd doctor` | Diagnostics |
| `ctxd install-hooks --client <claude-code\|codex>` | Write the hook and MCP config snippets (with confirmation and a backup of existing files) |
| `ctxd inbox pull\|status\|set-token <token>` | Mobile inbox: pull and apply, pending count, store the hub token in the Keychain (17.6) |
| `ctxd features` / `ctxd features set <name> on\|off` | List every feature flag with its effective value and source, or set one (3.1) |
