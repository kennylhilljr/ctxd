/**
 * Native skill sync (SPEC v8 12.2): writes approved skill entries into a client's personal
 * skills folder, so they load natively (including from Claude Code's `/` menu). Only the
 * scopes in `skills.include_scopes` (default `_me` only); never overwrites a folder it did not
 * write itself, or a file that was edited locally since; removes files for skills that are no
 * longer selected.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { renderSyncedSkill } from "./skillmd.js";
import { formatRef } from "../model/refs.js";
import { INSTALL_HOOKS_CLIENTS, type InstallHooksClient } from "../cli/install-hooks.js";
import { loadConfig } from "../config/config.js";
import { isFlagOn, resolveFlags } from "../config/flags.js";
import { loadScopeByName } from "../store/snapshot.js";
import { spawnWorker } from "../hooks/writeMoments.js";
import { writeStateFileLocked } from "../hooks/stateFile.js";

/** The client's personal skills folder, or null when it is not yet confirmed (SPEC v8 open issue 16: Codex's path is unverified, so it is never guessed). */
export function clientSkillsDir(client: InstallHooksClient, home: string = homedir()): string | null {
  if (client === "claude-code") return join(home, ".claude", "skills");
  return null;
}

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

interface SkillEntryRow {
  entry_id: string;
  scope_id: string;
  skill_name: string;
  body: string;
  created_hlc: string;
}

/**
 * Active skills in the given scopes, the earliest of any same-(scope, name) duplicate only
 * (SPEC 4.3's name-clash rule: lookup, catalogs and sync use the earliest; the rest are listed
 * in `ctxd review` and not served). Flagged, quarantined, superseded, archived and deleted
 * skills are already excluded by `status = 'active'`.
 */
function selectSkills(db: Database.Database, scopeIds: string[]): SkillEntryRow[] {
  if (scopeIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT entry_id, scope_id, skill_name, body, created_hlc FROM entries
       WHERE kind = 'skill' AND status = 'active' AND skill_name IS NOT NULL AND scope_id IN (${scopeIds.map(() => "?").join(",")})`,
    )
    .all(...scopeIds) as SkillEntryRow[];
  const bestByKey = new Map<string, SkillEntryRow>();
  for (const row of rows) {
    const key = `${row.scope_id}\u0000${row.skill_name}`;
    const existing = bestByKey.get(key);
    if (!existing || row.created_hlc < existing.created_hlc) bestByKey.set(key, row);
  }
  return [...bestByKey.values()];
}

export interface SyncReport {
  written: string[];
  removed: string[];
  skipped: { name: string; reason: string }[];
}

export function syncSkillsForClient(
  db: Database.Database,
  client: InstallHooksClient,
  scopeIds: string[],
  scopeNameById: Map<string, string>,
  keepAllowedTools: boolean,
  home?: string,
): SyncReport {
  const report: SyncReport = { written: [], removed: [], skipped: [] };
  const dir = clientSkillsDir(client, home);
  if (!dir) {
    report.skipped.push({ name: "*", reason: `${client}'s personal skills folder is not yet confirmed (SPEC v8 open issue 16)` });
    return report;
  }

  const selected = selectSkills(db, scopeIds);
  const selectedEntryIds = new Set(selected.map((s) => s.entry_id));

  const synced = db.prepare("SELECT skill_entry, path, content_hash FROM skill_syncs WHERE client = ?").all(client) as {
    skill_entry: string;
    path: string;
    content_hash: string;
  }[];
  const syncedByEntry = new Map(synced.map((s) => [s.skill_entry, s]));

  for (const skill of selected) {
    const scopeName = scopeNameById.get(skill.scope_id) ?? skill.scope_id;
    const ref = formatRef(scopeName, skill.entry_id);
    const target = join(dir, skill.skill_name, "SKILL.md");
    const rendered = renderSyncedSkill(skill.body, ref, keepAllowedTools);
    const renderedHash = hashOf(rendered);
    const already = syncedByEntry.get(skill.entry_id);

    if (existsSync(target)) {
      if (!already) {
        report.skipped.push({ name: skill.skill_name, reason: `${target} already exists and was not written by ctxd` });
        continue;
      }
      const onDiskHash = hashOf(readFileSync(target, "utf8"));
      if (onDiskHash !== already.content_hash) {
        report.skipped.push({ name: skill.skill_name, reason: `${target} was edited locally; run "ctxd skills import" to bring the edit back for review` });
        continue;
      }
      if (onDiskHash === renderedHash) continue; // already up to date
    }

    writeFileAtomic(target, rendered);
    db.prepare(
      `INSERT INTO skill_syncs (client, skill_entry, path, content_hash, synced_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (client, skill_entry) DO UPDATE SET path = excluded.path, content_hash = excluded.content_hash, synced_at = excluded.synced_at`,
    ).run(client, skill.entry_id, target, renderedHash, new Date().toISOString());
    report.written.push(skill.skill_name);
  }

  for (const s of synced) {
    if (selectedEntryIds.has(s.skill_entry)) continue;
    if (existsSync(s.path) && hashOf(readFileSync(s.path, "utf8")) === s.content_hash) {
      rmSync(s.path);
      try {
        rmdirSync(dirname(s.path)); // only succeeds if ctxd's folder is now empty
      } catch {
        // not empty, or a stranger's folder: leave it.
      }
    }
    db.prepare("DELETE FROM skill_syncs WHERE client = ? AND skill_entry = ?").run(client, s.skill_entry);
    report.removed.push(s.path);
  }

  return report;
}

/**
 * W5.4: automatic native skill sync. A write that touches a skill entry (src/tools/write.ts's
 * contextWrite) schedules this through the same ticket-plus-detached-worker mechanism SessionEnd
 * uses (SPEC 9.7), rather than running the actual folder sync inline in the write path or inside
 * a hook's time budget: writing skill files is disk I/O for every configured client, which has no
 * place being on the critical path of an unrelated tool call.
 */
export interface SkillSyncTicket {
  kind: "skill-sync";
  createdAt: string;
}

/** `sessions/skill-sync.<createdAtMs>.ticket.json`: the same ticket directory and crash-sweep-recoverable naming convention as a SessionEnd ticket, distinguished by `kind`. */
export function skillSyncTicketPath(dataDir: string, createdAtMs: number): string {
  return join(dataDir, "sessions", `skill-sync.${createdAtMs}.ticket.json`);
}

/** Writes the ticket and spawns a detached `ctxd worker` for it. `spawnFn` is overridable only for tests. */
export async function scheduleSkillSync(dataDir: string, configPath: string, spawnFn: typeof spawnWorker = spawnWorker): Promise<void> {
  const createdAtMs = Date.now();
  const ticket: SkillSyncTicket = { kind: "skill-sync", createdAt: new Date(createdAtMs).toISOString() };
  const path = skillSyncTicketPath(dataDir, createdAtMs);
  await writeStateFileLocked(path, ticket);
  spawnFn(path, dataDir, configPath);
}

/**
 * The deferred work behind a skill-sync ticket: re-syncs every configured client from current
 * active skills, exactly what `ctxd skills sync` (no `--client`) does. A no-op if
 * `skills.native_sync` has since been turned off, since the flag may have changed between
 * scheduling and the worker actually running.
 */
export function runSkillSyncTicket(db: Database.Database, configPath: string, home?: string): void {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(configPath);
  } catch {
    return; // no config at this path (e.g. before ctxd init, or an unresolved test default): nothing to sync
  }
  if (!isFlagOn(resolveFlags(config), "skills.native_sync")) return;

  const scopes = config.skills.include_scopes.flatMap((name) => {
    const scope = loadScopeByName(db, name);
    return scope ? [{ id: scope.id, name }] : [];
  });
  const scopeNameById = new Map(scopes.map((s) => [s.id, s.name]));
  const scopeIds = scopes.map((s) => s.id);

  for (const client of config.skills.sync_clients) {
    if (!(INSTALL_HOOKS_CLIENTS as readonly string[]).includes(client)) continue; // unknown client name; ctxd skills sync itself still reports this
    syncSkillsForClient(db, client as InstallHooksClient, scopeIds, scopeNameById, config.skills.keep_allowed_tools, home);
  }
}
