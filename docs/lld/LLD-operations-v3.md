# ctxd LLD: Operations, Mirror and Skill Sync (v3)

| | |
|---|---|
| **Status** | Draft v3 |
| **Date** | 2026-11-25 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) section 12 |
| **Implements** | [Trust and safety](../prd/components/PRD-trust-safety-v5.md) (backups, startup checks), [Replication](../prd/components/PRD-replication-v7.md) (hub migration), [Filesystem view](../prd/components/PRD-filesystem-view-v3.md) (mirror and import, FS-6, FS-8 and FS-10), [Skills](../prd/components/PRD-skills-v3.md) (native sync) |
| **Owner** | A (agent-generated) by persona `sre`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/cli/`, `src/fsview/`, `src/mirror/`, `src/skills/`, `deploy/` |
| **Moved from** | Spec v9 section 12; Spec v10 draft W5.4 and W5.5 |
| **Supersedes** | [v2](LLD-operations-v2.md), which added to 12.1 how a mirror import reaches its canonical path so a stop never imports a file twice (#85). v3 publishes the 12.1 rules that later fixes wrote into v2 in place: how an edit to a written but untracked mirror file is reconciled instead of overwritten (#88), how such a file is removed once its entry stops being mirrored (#91), how entries that share a canonical path are each mirrored to their own file (#95), and how journal mirror files are named so an edit keeps its own conflict copy (#99). The text is v2 as it stands; no behavior changes (#102) |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 12. Operations

- **Service:** `launchd` agent `dev.ctxd.server` with `KeepAlive` and `RunAtLoad`.
- **Logs:** `~/Library/Logs/ctxd/`.
- **One launchd helper for all three agents** (`src/cli/launchd.ts`, W11). ctxd installs three
  agents: the keepalive server above, the daily backup below, and the mobile inbox's interval pull
  ([LLD: Mobile inbox](LLD-mobile-inbox-v1.md) 17.6). They differ only in what they launch and in
  one scheduling key (`RunAtLoad` plus `KeepAlive`, `StartCalendarInterval`, or `StartInterval`),
  so plist generation, the `plutil` lint, the `launchctl` calls and the `launchctl list` status
  parsing live in one place. Two behaviors all three had wrong while each carried its own copy:
  - **Install reloads, so a reinstall applies.** Loading a label launchd already knows prints
    `Load failed: 5: Input/output error` *and exits 0*, so the old code wrote the new plist,
    discarded launchd's complaint because the exit status looked fine, and left the running job on
    its previous definition. Changing a schedule and reinstalling therefore did nothing, silently.
    Install now unloads first (ignoring the failure when nothing was loaded) and checks `load`'s
    own output rather than its exit code, so a refused load becomes an error the command reports.
  - **Paths written into a plist are absolute.** launchd gives a job no useful working directory,
    so a relative `--config ./ctxd.toml` would not resolve at run time; both `--config` and
    `--data-dir` are resolved before they are written.

  For anyone writing a test here: `launchctl list <label>` reports `Label`, `OnDemand`,
  `LastExitStatus`, `Program` and `ProgramArguments`, but **not** the schedule, so a changed
  interval is only observable in the plist on disk while a changed argument is observable in the
  definition launchd is actually holding.
- **Health:** `GET /healthz` on the MCP listener; `ctxd doctor` checks:
  - bind addresses;
  - token file permissions;
  - DB integrity (`PRAGMA quick_check`);
  - review rules that are broader than allowed (should never occur);
  - peer reachability and last sync age: each peer's real age from `peers.last_synced_at` (a peer that never synced uses its `created_at`), with a warning past `sync.stale_hours` (default 24) (W3);
  - rejected replicated events: fails while `sync_rejections` holds any row, naming each peer, its count, the last rejection time and the latest reason (#74, replication 7.1);
  - skipped mirror files: fails while `mirror_skips` holds any row, naming up to ten paths with their error code, reason and last attempt (#72, 12.1);
  - FileVault status;
  - hook installation per client;
  - backup age: the newest `*.db.age` file's modification time in `backups/`, warning past 36 hours; it fails when no backup exists yet, and is informational when `backups` is off (W4).
- **Startup integrity.** The server runs `PRAGMA quick_check` and a schema version check before listening. If the database is missing but backups or peers exist, or if it is unreadable or corrupt, the server refuses to start and points to `ctxd doctor` and `ctxd restore`. It never creates a fresh empty database over an existing path. `ctxd init` is the only command that creates one.
- **Backups:** `ctxd backup schedule install|uninstall|status` installs a launchd agent that runs `ctxd backup` daily at `backup.schedule` (local `HH:MM`, default `03:15`) through `StartCalendarInterval`, not `RunAtLoad` or `KeepAlive`, through the shared launchd helper above; it respects the `backups` flag, and installing it on a real machine is the owner's step (W4). Each run is a nightly `VACUUM INTO` to a temporary file, then `age` encryption to `backups/`, keeping 14 copies, then an optional copy to `copy_to`. `ctxd restore <file>` is tested in CI.
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

Implements [Filesystem view](../prd/components/PRD-filesystem-view-v3.md) section 5. `ctxd mirror start` runs the mirror inside the server process; it is off by default.

- **Whose view.** The mirror is written as the human client and shows every scope I can read, except sealed pools, which are never written to disk in plaintext. The mirror directory is under the data directory, so the path guard (9.9) blocks agents from it.
- **Files.** One file per entry at its path (4.2), except that a journal entry (`journal/<YYYY>/<MM>/<DD>.md#<slug>`) is written to `journal/<YYYY>/<MM>/<DD>--<slug>.md`, so every mirror file ends in `.md`, is read back, and has a conflict copy (`<name>.conflict.md`) that is always a separate file. A journal file under its older name (`<DD>.md--<slug>`), tracked or not, is first renamed to the new name, unless a file is already there, and is then handled as any file at that path, so an edit is reconciled once and its conflict copy is `<DD>--<slug>.conflict.md`; its tracking row (matched ignoring letter case) moves before the file, so a stop in between never reads as a deletion, and a conflict record at the old name is dropped, since its copy was the file itself (#99). Generated files are also written: `.abstract.md` and `.overview.md` per folder (read-only). Entries that share a path (an offline slug collision, [LLD-data-model](LLD-data-model-v1.md) section 4.2, compared ignoring letter case) are each written to that path with the lowercase entry id inserted before `.md` (for example `notes/use-an-event-log-7k2pqz.01jabcdef000000000007k2pqz.md`), so no entry overwrites another's file; nothing is written at the shared path. When a collision appears or is resolved, a tracked file at the entry's old path is reconciled as an edit (applied, or kept as `<name>.conflict.md`), then its tracking is dropped and it is removed (in that order, so a stop in between never reads as a deletion), and the export writes the entry at its new path; a tracked file deleted in that cycle opens one archive request. An untracked file at a shared path may hold an edit meant for any of the entries, so it is never matched, overwritten or imported: it stays in place and is recorded in `mirror_skips` (code `REV_CONFLICT`) so `ctxd doctor` names it; it is held so until it is removed, even after the collision is resolved, and its path is not written meanwhile. `ctxd open` on a shared path lists the entries' own files instead of opening it. An untracked file at an entry's own (id-named) path is treated as at its canonical path when that entry leaves the mirror (#91) (#95, FS-6). Each entry file has YAML frontmatter, then the body:

```markdown
---
ref: ctxd:sample-app/01JABCDEF000000000007K2PQZ
kind: decision
status: active
rev: 3-01JABCDEF0
by: claude-code@laptop
updated: 2026-10-18T14:02:11Z
review_after: null
links: ["[[supersedes::ctxd:sample-app/01JAB...]]"]
---
# Use an event log, not cr-sqlite
...
```

- **Writing out.** While the feature is enabled, the server reconciles the mirror every 2 seconds. It rewrites files atomically (temporary file, then rename), and `mirror_files` records the revision and file hash.
- **Containment.** Every write, rename and unlink in the mirror (and every file `ctxd export` writes) resolves against the mirror root and is refused if the result lies outside it or passes through a symbolic link below the root. This is defence in depth behind the name and slug validation in [LLD-data-model](LLD-data-model-v1.md) section 4. Implements FS-10; criteria FS-AC-9 (outside the root), FS-AC-10 (symbolic links in the mirror) and FS-AC-11 (export).
- **Reading back.** Each reconciliation processes changed files:
  - **Unchanged hash:** ignore, so ctxd's own writes do not loop.
  - **Edited file:** compare the frontmatter `rev` with the current content revision. If it matches, apply the edit as a human-client update through the write path (6). If not, write `<name>.conflict.md` beside the file with my version and add a review item; nothing is applied.
  - **Written but untracked file:** a file at a live entry's canonical path with no `mirror_files` row (ctxd stopped between writing it and tracking it) is reconciled against that entry, whatever its `ref` says, before the export rewrites it: unchanged, it is tracked; edited, it is applied or kept as `<name>.conflict.md` (stale revision, immutable kind, unparseable or refused edit) and then tracked. The reconciliation is one transaction, so an edit refused part way changes nothing, while a refusal by the write path keeps its rejection record. If even the conflict copy cannot be written, the file is left untracked and untouched and retried next cycle. Files at canonical paths are reconciled before pending imports are replayed, so a replay never rewrites such an edit first; a file under another letter case that is the canonical file (same inode) is renamed to the canonical case and reconciled; a path two entries share (an offline slug collision) is never matched to either (#88).
  - **Changed frontmatter fields:** only `status` (as a review action) and `review_after` are honored; edits to `ref`, `kind`, `rev`, `by` and `updated` are ignored and restored on the next write.
  - **Written but untracked file of an entry no longer mirrored:** a file with no `mirror_files` row at the canonical path of an entry that has since stopped being mirrored is removed, as the tracked loop removes a file whose entry is gone (#91). Any untracked file with a `ref` in its leading frontmatter (read tolerantly: indented, either quote, or an unclosed block) in a sealed scope's folder is deleted, with any `<name>.conflict.md` and its conflict record, whatever else it holds (an edited `ref`, unparseable frontmatter), since sealed pools are never on disk in plaintext; sealing erases the scope's entries from the main database, so this match is by folder, not by entry. A file there without a `ref` is a new note and stays refused and skipped. When its `ref` names a purged entry at that entry's canonical path (for a skill rebuilt without its name, any `skills/<name>/SKILL.md` in its scope), it is deleted the same way. When its `ref` names an archived, deleted, superseded or quarantined entry at that entry's canonical path, its content (frontmatter `rev`, title, body and tags) is compared with the entry's: unchanged, the file is deleted; edited or no longer parseable, it is first kept as `<name>.conflict.md` with a conflict record, so the edit is not lost. A conflict copy is always deleted before the file, so a stop in between leaves the file to be found again. A conflict copy is never walked, so each cycle also deletes, with its record, any conflict copy in a sealed scope's folder or of a purged entry. The frontmatter is read with Windows line endings too. A file with a `ref` anywhere else is left alone.
  - **New file with frontmatter `kind` in a kind folder:** creates an entry in that scope. A new file that cannot be imported (a sealed scope refuses mirror writes, an unknown kind, a partial save) stays in place and is retried every cycle; its path, error code and reason are recorded in `mirror_skips` so `ctxd status` and `ctxd doctor` show why it never arrived, and the record is cleared once the file imports or is removed (#72). The import is idempotent: its request id is derived from the file's path and content, and the request id of an import is kept in `mirror_skips.pending_request_id` (code `PENDING_MOVE` until a failure records its reason) from the moment it commits until the file reaches its canonical path, so a retry after a failed move or a crash replays the earlier write instead of creating a second entry; an identical file put back after a completed import is a new entry. If that entry stopped being mirrored in the meantime (archived or quarantined), the file stays skipped until it is edited (#83). The move to the canonical path writes the entry, with its `ref`, there and records it in `mirror_files` before the source file is removed, so a stop at any point leaves either the pending source (replayed on restart) or a tracked file that names its entry, never an untracked copy that would import as a second entry; where the source is the canonical file under another letter case (a case-insensitive filesystem), it is renamed to the canonical case instead of removed, and a tracked file found under another case is renamed back to its tracked name rather than imported (#85, FS-6).
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
