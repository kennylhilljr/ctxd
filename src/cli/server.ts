/** `ctxd server`: run the MCP server (used by launchd in M4) (SPEC v6 section 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveConfigPath, resolveDataDir } from "./common.js";
import { loadConfig } from "../config/config.js";
import { resolveFlags, isFlagOn } from "../config/flags.js";
import { openDatabase } from "../store/db.js";
import { startServer } from "../server/mcp.js";
import { startSyncServer } from "../server/sync.js";
import { runSync } from "./sync.js";

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const configPath = resolveConfigPath({ configPath: values.config });
  const config = loadConfig(configPath);
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const dbPath = join(dataDir, "ctxd.db");

  const db = openDatabase(dbPath); // never creates (SPEC v6 section 12): ctxd init is the only command that does
  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
  if (!node) {
    console.error("ctxd server: no node identity found; run ctxd init first.");
    db.close();
    return 1;
  }

  // Flags are resolved once here, at server startup, unlike the per-request live reload in
  // server/mcp.ts: starting or stopping the sync listener or the puller interval mid-process
  // needs a restart either way (there is nothing to "reload" for an HTTP listener's own
  // existence), so there is no live-reload property to preserve for these two flags.
  const flags = resolveFlags(config);
  const syncServeOn = isFlagOn(flags, "sync.serve");

  const [server, syncServer] = await Promise.all([
    startServer({ db, nodeId: node.node_id, listen: config.mcp.listen, configPath }),
    syncServeOn ? startSyncServer({ db, nodeId: node.node_id, listen: config.sync.listen }) : undefined,
  ]);
  console.log(`ctxd server listening on ${config.mcp.listen}`);
  if (syncServeOn) console.log(`ctxd server: sync listener on ${config.sync.listen}`);

  let pullInterval: NodeJS.Timeout | undefined;
  if (isFlagOn(flags, "sync")) {
    let pulling = false; // skip a tick rather than pile up concurrent pulls if one runs longer than interval_seconds
    pullInterval = setInterval(() => {
      if (pulling) return;
      pulling = true;
      void runSync(db, node.node_id, undefined).finally(() => {
        pulling = false;
      });
    }, config.sync.interval_seconds * 1000);
  }

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    if (pullInterval) clearInterval(pullInterval);
    void Promise.all([server.close(), syncServer?.close()]).then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  return new Promise<number>(() => {
    /* runs until SIGINT/SIGTERM */
  });
}
