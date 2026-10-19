/**
 * `ctxd skills import --from <client> [--scope _me]` (SPEC v8 12.2): reads existing personal
 * skill files and creates them as proposed skill entries for review. Written through a
 * synthetic "import" client (vendor `other`), never the human client: SPEC v6's access rule
 * makes every human write land `active` immediately, which "proposed for review" rules out.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { CtxdError } from "../core/errors.js";
import { writeEntry, type WriteContext } from "../store/write.js";
import { clientSkillsDir } from "./sync.js";
import type { InstallHooksClient } from "../cli/install-hooks.js";

/** Finds or creates the synthetic "import" client (vendor `other`) used so imported skills land proposed, not active. */
export function ensureImportClient(db: Database.Database, nodeId: string): string {
  const existing = db.prepare("SELECT client_id FROM clients WHERE name = 'import'").get() as { client_id: string } | undefined;
  if (existing) return existing.client_id;
  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'import', 'other', ?, ?, ?)").run(
    clientId,
    nodeId,
    newId(),
    nowIso(),
  );
  return clientId;
}

export interface ImportResult {
  imported: { name: string; ref: string }[];
  skipped: { name: string; reason: string }[];
}

export function importSkillsFrom(ctx: WriteContext, client: InstallHooksClient, scope: string, dryRun = false, home?: string): ImportResult {
  const result: ImportResult = { imported: [], skipped: [] };
  const dir = clientSkillsDir(client, home);
  if (!dir || !existsSync(dir)) {
    result.skipped.push({
      name: "*",
      reason: dir ? `${dir} does not exist` : `${client}'s personal skills folder is not yet confirmed (SPEC v8 open issue 16)`,
    });
    return result;
  }

  const syncedPaths = new Set(
    (ctx.db.prepare("SELECT path FROM skill_syncs WHERE client = ?").all(client) as { path: string }[]).map((s) => s.path),
  );

  for (const name of readdirSync(dir)) {
    const path = join(dir, name, "SKILL.md");
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    if (syncedPaths.has(path)) {
      result.skipped.push({ name, reason: "already managed by ctxd (written by a previous sync); nothing to bring back" });
      continue;
    }
    const body = readFileSync(path, "utf8");
    if (dryRun) {
      result.imported.push({ name, ref: "(dry run)" });
      continue;
    }
    try {
      const write = writeEntry(ctx, { scope, kind: "skill", title: name, body, request_id: newId() } as never);
      if ("held" in write) result.skipped.push({ name, reason: write.message });
      else result.imported.push({ name, ref: write.ref });
    } catch (err) {
      result.skipped.push({ name, reason: err instanceof CtxdError ? err.message : String(err) });
    }
  }
  return result;
}
