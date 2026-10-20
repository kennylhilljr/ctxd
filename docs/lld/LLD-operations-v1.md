# ctxd LLD: Operations, Mirror and Skill Sync (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 12 |
| **Implements** | [Trust and safety](../prd/components/PRD-trust-safety-v5.md) (backups, startup checks), [Replication](../prd/components/PRD-replication-v6.md) (hub migration), [Filesystem view](../prd/components/PRD-filesystem-view-v2.md) (mirror, import), [Skills](../prd/components/PRD-skills-v3.md) (native sync) |
| **Owner** | A (agent-generated) by persona `sre`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/cli/`, `src/fsview/`, `src/skills/`, `deploy/` |
| **Moved from** | Spec v9 section 12; Spec v10 draft W5.4 and W5.5 |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 12. Operations

- **Service:** `launchd` agent `dev.ctxd.server` with `KeepAlive` and `RunAtLoad`.
- **Logs:** `~/Library/Logs/ctxd/`.
- **Health:** `GET /healthz` on the MCP listener; `ctxd doctor` checks:
  - bind addresses;
  - token file permissions;
  - DB integrity (`PRAGMA quick_check`);
  - review rules that are broader than allowed (should never occur);
  - peer reachability and last sync age: each peer's real age from `peers.last_synced_at` (a peer that never synced uses its `created_at`), with a warning past `sync.stale_hours` (default 24) (W3);
  - FileVault status;
  - hook installation per client.
- **Startup integrity.** The server runs `PRAGMA quick_check` and a schema version check before listening. If the database is missing but backups or peers exist, or if it is unreadable or corrupt, the server refuses to start and points to `ctxd doctor` and `ctxd restore`. It never creates a fresh empty database over an existing path. `ctxd init` is the only command that creates one.
- **Backups:** nightly `VACUUM INTO` to a temporary file, then `age` encryption to `backups/`, keeping 14 copies, then an optional copy to `copy_to`. `ctxd restore <file>` is tested in CI.
- **Air settings:**
  - prevent sleep on power;
  - restart automatically after power failure;
  - FileVault on (accept manual unlock after outages);
  - battery charge limiting if supported.
- **Migration to a new hub** (step-by-step procedure: [runbooks/hub-migration-v1.md](../runbooks/hub-migration-v1.md)):
  1. Stop the old server.
  2. Copy the data directory and config.
  3. Run `ctxd node adopt <new-name>`. It changes the config and local node name together, preserves `node_id`, and refuses a running server, an invalid local identity or an active peer name collision.
  4. Move the `tailscale serve` config.
  5. Update peers' URLs, or reuse a stable MagicDNS name via a dedicated tailnet machine name.

### 12.1 Markdown mirror and import

Implements [Filesystem view](../prd/components/PRD-filesystem-view-v2.md) section 5. `ctxd mirror start` runs the mirror inside the server process; it is off by default.

- **Whose view.** The mirror is written as the human client and shows every scope I can read, except sealed pools, which are never written to disk in plaintext. The mirror directory is under the data directory, so the path guard (9.9) blocks agents from it.
- **Files.** One file per entry at its path (4.2), plus generated `.abstract.md` and `.overview.md` per folder (read-only). Each entry file has YAML frontmatter, then the body:

```markdown
---
ref: ctxd:ctxd/01JABCDEF000000000007K2PQZ
kind: decision
status: active
rev: 3-01JABCDEF0
by: claude-code@laptop
updated: 2026-10-18T14:02:11Z
review_after: null
links: ["[[supersedes::ctxd:ctxd/01JAB...]]"]
---
# Use an event log, not cr-sqlite
...
```

- **Writing out.** While the feature is enabled, the server reconciles the mirror every 2 seconds. It rewrites files atomically (temporary file, then rename), and `mirror_files` records the revision and file hash.
- **Reading back.** Each reconciliation processes changed files:
  - **Unchanged hash:** ignore, so ctxd's own writes do not loop.
  - **Edited file:** compare the frontmatter `rev` with the current content revision. If it matches, apply the edit as a human-client update through the write path (6). If not, write `<name>.conflict.md` beside the file with my version and add a review item; nothing is applied.
  - **Changed frontmatter fields:** only `status` (as a review action) and `review_after` are honored; edits to `ref`, `kind`, `rev`, `by` and `updated` are ignored and restored on the next write.
  - **New file with frontmatter `kind` in a kind folder:** creates an entry in that scope.
  - **Deleted file:** opens an archive request in `ctxd review`; the file is restored until I confirm.
  - **Immutable kinds:** body edits are refused with a `.conflict.md` that explains how to supersede.
- **Import.** `ctxd import <dir> --scope <name>` reads Markdown files with optional frontmatter (`kind`, `title`, `tags`); files without a kind become `note`. Everything is passed through the 6.1 pipeline in agent mode and arrives `proposed`, as the client `import`, for review. A dry run (`--dry-run`) prints what would be created.

### 12.2 Native skill sync

Implements [Skills](../prd/components/PRD-skills-v3.md) section 3. `ctxd skills sync [--client <id>]` runs on demand and after any change to a synced skill:

1. **Select.** Active skills in the scopes listed in `skills.include_scopes` (default only `_me`), excluding name clashes (4.3) and skills with open flags.
2. **Target.** The client adapter declares its personal skills folder: Claude Code `~/.claude/skills/<name>/SKILL.md`; Codex `~/.agents/skills/<name>/SKILL.md`, confirmed from the `openai/codex` source at the pinned minimum version `rust-v0.145.0` (`codex-rs/core-skills/src/loader.rs` resolves the user skill root as `home_dir.join(".agents").join("skills")`). Codex still scans a deprecated `$CODEX_HOME/skills` fallback; ctxd writes only to the current location (Spec v10 draft W5.5).
3. **Write.** Write the SKILL.md atomically with a first-line comment after the frontmatter naming its reference and `managed by ctxd; edit in ctxd`. `allowed-tools` is removed unless `skills.keep_allowed_tools` is true, so a synced skill never pre-approves tools by default. Record the path and hash in `skill_syncs`.
4. **Never overwrite a stranger.** If the target folder exists and is not in `skill_syncs`, skip it and report the clash. If the file's hash differs from the recorded one (a local edit), skip it and report; `ctxd skills import` can bring the edit back as a proposed revision.
5. **Remove.** Files in `skill_syncs` whose skill is no longer selected (flagged, quarantined, archived, superseded, purged or moved out of the included scopes) are deleted, along with their folder if ctxd created it and it is otherwise empty.

`ctxd skills import --from claude-code|codex [--scope _me]` reads existing personal skills and creates them as `proposed` skill entries for review.

**Automatic sync** (Spec v10 draft W5.4). A write to a skill entry (`context_write`) and an approval of a proposed skill (`ctxd review --approve`) schedule a sync when `skills.native_sync` is on, through the same ticket and detached worker mechanism SessionEnd uses (9.7): a `skill-sync` ticket under `sessions/`, picked up by `ctxd worker` or, if left behind, by the next crash sweep.

- The folder write never runs inline in the write path or inside a hook's time budget.
- The trigger fires on the entry's kind alone, not its resulting status; scheduling a sync for a write that leaves the skill `proposed` is harmless, since sync selects only `active` skills.
- If `skills.native_sync` is off by the time the worker runs, the ticket is a no-op, not an error.
