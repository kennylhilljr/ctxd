/** `ctxd server`: run the MCP server (used by launchd in M4) (SPEC v6 section 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveConfigPath, resolveDataDir } from "./common.js";
import { loadConfig } from "../config/config.js";
import { openDatabase } from "../store/db.js";
import { startServer } from "../server/mcp.js";

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

  const server = await startServer({ db, nodeId: node.node_id, listen: config.mcp.listen });
  console.log(`ctxd server listening on ${config.mcp.listen}`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => {
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
