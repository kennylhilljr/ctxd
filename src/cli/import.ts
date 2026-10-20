import { parseArgs } from "node:util";
import { join } from "node:path";
import { HlcClock } from "../core/hlc.js";
import { loadConfig } from "../config/config.js";
import { resolveFlags } from "../config/flags.js";
import { appendAclEvent } from "../store/acl.js";
import { openDatabase } from "../store/db.js";
import { loadScopeByName } from "../store/snapshot.js";
import { ensureImportClient } from "../skills/importSkills.js";
import { importMarkdown } from "../mirror/markdown.js";
import { resolveConfigPath, resolveDataDir, resolveHumanWriteContext } from "./common.js";

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, options: { scope: { type: "string" }, "dry-run": { type: "boolean" }, "data-dir": { type: "string" }, config: { type: "string" } }, allowPositionals: true, strict: true });
  const dir = positionals[0];
  if (!dir || !values.scope) { console.error("Usage: ctxd import <dir> --scope <name> [--dry-run]"); return 1; }
  const configPath = resolveConfigPath({ configPath: values.config });
  const flags = resolveFlags(loadConfig(configPath));
  const db = openDatabase(join(resolveDataDir({ dataDir: values["data-dir"], configPath }), "ctxd.db"));
  try {
    const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string };
    const scope = loadScopeByName(db, values.scope);
    if (!scope) throw new Error(`Scope not found: ${values.scope}`);
    const importId = ensureImportClient(db, node.node_id);
    if (!values["dry-run"] && !db.prepare("SELECT 1 FROM client_grants WHERE client_id = ? AND scope_id = ?").get(importId, scope.id)) {
      const human = resolveHumanWriteContext(db); human.flags = flags;
      appendAclEvent(human, importId, { action: "client_grant", scope_id: scope.id, level: "propose", expires_at: null, granted_by: human.clientId });
    }
    const result = importMarkdown({ db, clock: new HlcClock(node.node_id), nodeId: node.node_id, clientId: importId, flags }, dir, values.scope, values["dry-run"] ?? false);
    console.log(`ctxd import: ${result.imported} ${values["dry-run"] ? "would be imported" : "imported"}, ${result.skipped.length} skipped.`);
    for (const skipped of result.skipped) console.log(`  skipped ${skipped}`);
    return 0;
  } catch (err) { console.error(`ctxd import: ${err instanceof Error ? err.message : String(err)}`); return 1; }
  finally { db.close(); }
}
