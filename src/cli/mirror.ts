import { parseArgs } from "node:util";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config/config.js";
import { requireFlag, resolveFlags } from "../config/flags.js";
import { syncMirror } from "../mirror/markdown.js";
import { openDatabase } from "../store/db.js";
import { resolveConfigPath, resolveDataDir, resolveHumanWriteContext } from "./common.js";

export function run(argv: string[]): number {
  const [sub = "status", ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { "data-dir": { type: "string" }, config: { type: "string" }, dir: { type: "string" } }, strict: true });
  const configPath = resolveConfigPath({ configPath: values.config });
  const config = loadConfig(configPath);
  const flags = resolveFlags(config);
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath });
  const dir = expandHome(values.dir ?? config.mirror.dir);
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    if (sub === "stop") { console.log("ctxd mirror: no watcher is running in this process."); return 0; }
    if (sub === "status") {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM mirror_files").get() as { n: number }).n;
      console.log(`ctxd mirror: ${flags.get("mirror") ? "enabled" : "disabled"}; ${count} tracked file(s); ${dir}`);
      return 0;
    }
    if (sub !== "start" && sub !== "sync") { console.error("Usage: ctxd mirror start|sync|stop|status [--dir <path>]"); return 2; }
    requireFlag(flags, "mirror");
    const ctx = resolveHumanWriteContext(db);
    ctx.flags = flags;
    const result = syncMirror(ctx, dir);
    console.log(`ctxd mirror: ${result.written} written, ${result.applied} applied, ${result.conflicts} conflict(s), ${result.archiveRequests} archive request(s).`);
    return 0;
  } catch (err) {
    console.error(`ctxd mirror: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally { db.close(); }
}
