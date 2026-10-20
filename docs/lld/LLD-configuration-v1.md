# ctxd LLD: Configuration and Feature Flags (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 3 |
| **Implements** | [Feature flags](../prd/components/PRD-feature-flags-v2.md) (FF-1 to FF-7); [Trust and safety](../prd/components/PRD-trust-safety-v5.md) (capture filters) |
| **Owner** | A (agent-generated) by persona `component-designer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/config/` |
| **Moved from** | Spec v9 section 3 (configuration examples and keys) and 3.1 |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 3. Configuration

The file locations are listed in [Spec v10](../spec/SPEC-v10.md) section 3. This section holds the configuration keys.

```toml
# ~/.config/ctxd/config.toml (example)
[node]
name = "air"                     # stable, human-readable
role = "home"                    # "home" or "roaming"
data_dir = "~/Library/Application Support/ctxd"

[mcp]
listen = "127.0.0.1:7411"

[sync]
listen = "127.0.0.1:7412"
interval_seconds = 120
stale_hours = 24                 # ctxd doctor warns when a peer's last sync is older (W3)
# Peers live in the database (`ctxd node add-peer`), not here: each one needs a token hash
# this machine can verify, which a config file is the wrong place to carry (3.1's notion of
# "per machine, never synced" config is for behavior flags, not secrets).

[brief]
micro_tokens = 300
normal_tokens = 1500
full_tokens = 4000

[nudge]
enabled = true
min_minutes_between = 30
turns_threshold = 20
completion_markers = ["done", "implemented", "merged", "complete"]

[scope_map]                      # optional path or remote to scope mapping
"~/code/ctxd" = "ctxd"
"github.com/example/sample-app" = "sample-app"

[backup]
age_recipient = "age1..."
copy_to = ""                     # optional, e.g. a Google Drive folder path
schedule = "03:15"               # local HH:MM for the scheduled backup agent (W4)
```

### 3.1 Feature flags

Implements [PRD-feature-flags-v2](../prd/components/PRD-feature-flags-v2.md). One registry in code
(`src/config/flags.ts`): every flag has a name, a default, the milestone that introduced it, a
description and a stated off-behavior; a flag may name a parent, whose own "off" silences it
regardless of its own setting (`hooks.*` under `hooks`). Nothing reads a flag that is not in the
registry.

```toml
[features]                          # per machine; never synced
"hooks.nudge" = false
metering = false
```

**Three layers, last one wins:** the registry default, then `[features]` in `config.toml`, then
`CTXD_FEATURE_<NAME>` (the name upper-cased, dots as underscores; only the literal strings `0` and
`1` are recognized, anything else is ignored). `ctxd features` reports each flag's effective value
and which layer decided it (`default`, `config` or `environment`).

**Live, with no restart.** A hook process loads `config.toml` fresh on every invocation already (a
new process per call), so flag resolution there is live by construction; hooks never call the
server to check a flag, so a disabled hook exits 0 even with the server down. The long-running
server reloads `config.toml` once per incoming request rather than caching it: one small file
parse, and the only way a flag flip takes effect without a restart.

**Safety.** Off never deletes, rewrites or un-syncs data; it only stops new work, and turning a
flag back on resumes from the event log. The `tools/list` payload never varies by flag (`toolDefinitions()`
takes no flag input), so disabling a feature never changes the tool surface or its token cost. A
tool call that specifically needs a disabled feature fails with `NOT_ALLOWED` and the hint
`` Feature `<name>` is disabled on this machine. `` (`requireFlag`); M3's flags change behavior
instead of refusing a call, so the first real use of this is `sync` landing later in M3.

**`ctxd features`** (human only, since it is a local file edit reachable only from the terminal,
never from an MCP tool): no arguments lists every flag; `set <name> on|off` writes `[features]`
after validating the name against the registry.

### 3.2 Additional configuration keys

Scope resolution and bypass, which read `scope_map` and `hooks.bypass_patterns`, are specified in [LLD: Hooks](LLD-hooks-v1.md) section 3.3.

```toml
[hooks]
bypass_patterns = ["/tmp/**", "**/scratch/**"]
session_start_max_chars = 9500     # Claude Code shows about 10,000 characters inline
crash_grace_minutes = 30           # crash sweep (9.10)

[mirror]                           # Markdown mirror (12.1); human only
enabled = false
dir = "~/Library/Application Support/ctxd/mirror"

[local_model]                      # M6 proposal worker; loopback HTTP only
endpoint = "http://127.0.0.1:11434/api/generate"
model = "ctxd-local"
timeout_ms = 30000

[skills]                           # native skill sync (12.2)
sync_clients = []                  # e.g. ["claude-code", "codex"]
include_scopes = ["_me"]           # pool profiles or projects only if listed explicitly

[journal]
digest_node = "air"                # the one node that writes weekly digests (11.5)
digest_weekday = "sunday"

[[capture_filters]]                # user rules applied to mechanical captures (6.1 step 4b)
pattern = "(?i)corp-internal\\.example\\.com"
replace = "[internal-host]"
```
