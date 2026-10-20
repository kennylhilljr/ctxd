/** `ctxd skills list|show <name>|sync [--client <id>]|import --from <client>` (SPEC v8 4.3, 12.2). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { loadConfig } from "../config/config.js";
import { resolveFlags, isFlagOn } from "../config/flags.js";
import { loadScopeByName } from "../store/snapshot.js";
import { parseSkill } from "../skills/skillmd.js";
import { syncSkillsForClient } from "../skills/sync.js";
import { ensureImportClient, importSkillsFrom } from "../skills/importSkills.js";
import { INSTALL_HOOKS_CLIENTS, type InstallHooksClient } from "./install-hooks.js";
import { printShow } from "./show.js";
import { formatRef } from "../model/refs.js";
import { CtxdError } from "../core/errors.js";
import { HlcClock } from "../core/hlc.js";

function isInstallHooksClient(v: string): v is InstallHooksClient {
  return (INSTALL_HOOKS_CLIENTS as readonly string[]).includes(v);
}

function runList(db: Database.Database, scopeName: string | undefined): number {
  const scope = scopeName ? loadScopeByName(db, scopeName) : null;
  if (scopeName && !scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${scopeName}`, {}, "scope");
  const rows = (
    scope
      ? db.prepare("SELECT entry_id, scope_id, skill_name, body FROM entries WHERE kind = 'skill' AND status = 'active' AND scope_id = ?").all(scope.id)
      : db.prepare("SELECT entry_id, scope_id, skill_name, body FROM entries WHERE kind = 'skill' AND status = 'active'").all()
  ) as { entry_id: string; scope_id: string; skill_name: string; body: string }[];
  const scopeNames = new Map(
    (db.prepare("SELECT scope_id, name FROM scopes").all() as { scope_id: string; name: string }[]).map((s) => [s.scope_id, s.name] as const),
  );
  if (rows.length === 0) {
    console.log("ctxd skills: no active skills.");
    return 0;
  }
  for (const row of rows) {
    const name = scopeNames.get(row.scope_id) ?? row.scope_id;
    try {
      const parsed = parseSkill(row.skill_name, row.body);
      console.log(`${row.skill_name} (${name}): ${parsed.description}`);
    } catch {
      console.log(`${row.skill_name} (${name}): (invalid SKILL.md)`);
    }
  }
  return 0;
}

/** Resolves a skill by name: within `scopeName` if given, else the earliest match across every scope (SPEC 4.3's name-clash rule). */
function resolveSkillRef(db: Database.Database, name: string, scopeName: string | undefined): string | null {
  if (scopeName) {
    const scope = loadScopeByName(db, scopeName);
    if (!scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${scopeName}`, {}, "scope");
    const row = db
      .prepare("SELECT entry_id FROM entries WHERE scope_id = ? AND kind = 'skill' AND skill_name = ? AND status = 'active' ORDER BY created_hlc ASC LIMIT 1")
      .get(scope.id, name) as { entry_id: string } | undefined;
    return row ? formatRef(scopeName, row.entry_id) : null;
  }
  const rows = db
    .prepare("SELECT entry_id, scope_id FROM entries WHERE kind = 'skill' AND skill_name = ? AND status = 'active' ORDER BY created_hlc ASC")
    .all(name) as { entry_id: string; scope_id: string }[];
  if (rows.length === 0) return null;
  const scope = db.prepare("SELECT name FROM scopes WHERE scope_id = ?").get(rows[0]!.scope_id) as { name: string };
  return formatRef(scope.name, rows[0]!.entry_id);
}

function runSync(db: Database.Database, client: string | undefined, configPath: string | undefined): number {
  const config = loadConfig(configPath);
  const flags = resolveFlags(config);
  if (!isFlagOn(flags, "skills.native_sync")) {
    console.error(
      "ctxd skills sync: skills.native_sync is off (writes outside ctxd's own data folder stay off by default). Enable it with: ctxd features set skills.native_sync on",
    );
    return 1;
  }
  const clients = client ? [client] : config.skills.sync_clients;
  if (clients.length === 0) {
    console.log("ctxd skills sync: no client given and skills.sync_clients is empty; nothing to do.");
    return 0;
  }
  const scopes = config.skills.include_scopes.flatMap((name) => {
    const scope = loadScopeByName(db, name);
    return scope ? [{ id: scope.id, name }] : [];
  });
  const scopeNameById = new Map(scopes.map((s) => [s.id, s.name]));
  const scopeIds = scopes.map((s) => s.id);

  let code = 0;
  for (const c of clients) {
    if (!isInstallHooksClient(c)) {
      console.error(`ctxd skills sync: unknown client "${c}". Use ${INSTALL_HOOKS_CLIENTS.join(" or ")}.`);
      code = 1;
      continue;
    }
    const report = syncSkillsForClient(db, c, scopeIds, scopeNameById, config.skills.keep_allowed_tools);
    console.log(`ctxd skills sync (${c}): ${report.written.length} written, ${report.removed.length} removed, ${report.skipped.length} skipped.`);
    for (const w of report.written) console.log(`  wrote: ${w}`);
    for (const r of report.removed) console.log(`  removed: ${r}`);
    for (const s of report.skipped) console.log(`  skipped ${s.name}: ${s.reason}`);
  }
  return code;
}

function runImport(db: Database.Database, client: string | undefined, scopeName: string, dryRun: boolean): number {
  if (!client) {
    console.error("Usage: ctxd skills import --from <claude-code|codex> [--scope _me] [--dry-run]");
    return 1;
  }
  if (!isInstallHooksClient(client)) {
    console.error(`ctxd skills import: unknown client "${client}". Use ${INSTALL_HOOKS_CLIENTS.join(" or ")}.`);
    return 1;
  }
  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
  if (!node) throw new Error("no node identity found; run ctxd init first");
  const ctx = { db, clock: new HlcClock(node.node_id), nodeId: node.node_id, clientId: ensureImportClient(db, node.node_id) };

  const result = importSkillsFrom(ctx, client, scopeName, dryRun);
  console.log(`ctxd skills import (from ${client}): ${result.imported.length} ${dryRun ? "would be imported" : "imported"}, ${result.skipped.length} skipped.`);
  for (const i of result.imported) console.log(`  ${dryRun ? "would import" : "imported"}: ${i.name}${i.ref !== "(dry run)" ? ` -> ${i.ref}` : ""}`);
  for (const s of result.skipped) console.log(`  skipped ${s.name}: ${s.reason}`);
  return 0;
}

export function run(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (sub !== "list" && sub !== "show" && sub !== "sync" && sub !== "import") {
    console.error("ctxd skills: unknown subcommand. Use list, show, sync or import.");
    return 2;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      scope: { type: "string" },
      client: { type: "string" },
      from: { type: "string" },
      "dry-run": { type: "boolean" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    if (sub === "list") return runList(db, values.scope);

    if (sub === "show") {
      const name = positionals[0];
      if (!name) {
        console.error("Usage: ctxd skills show <name> [--scope <s>]");
        return 1;
      }
      const ref = resolveSkillRef(db, name, values.scope);
      if (!ref) {
        console.error(`ctxd skills show: no active skill named "${name}"${values.scope ? ` in ${values.scope}` : ""}.`);
        return 1;
      }
      return printShow(db, ref);
    }

    if (sub === "sync") return runSync(db, values.client, values.config);

    return runImport(db, values.from, values.scope ?? "_me", values["dry-run"] ?? false);
  } catch (err) {
    console.error(`ctxd skills: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
