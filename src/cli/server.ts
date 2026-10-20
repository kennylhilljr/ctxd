/** `ctxd server`: run the MCP server (used by launchd in M4) (SPEC v6 section 13). */
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath, resolveDataDir } from "./common.js";
import { loadConfig } from "../config/config.js";
import { resolveFlags, isFlagOn } from "../config/flags.js";
import { checkDatabaseIntegrity, openDatabase } from "../store/db.js";
import { startServer } from "../server/mcp.js";
import { startSyncServer } from "../server/sync.js";
import { runSync } from "./sync.js";
import { HlcClock } from "../core/hlc.js";
import type { WriteContext } from "../store/write.js";
import { runDueDigests } from "../journal/digest.js";
import { embedPendingEntries, ensureEmbedClient } from "../embed/compute.js";

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const configPath = resolveConfigPath({ configPath: values.config });
  if (!existsSync(configPath)) {
    console.error(`ctxd server: no config found at ${configPath}. Run "ctxd init" first.`);
    return 1;
  }
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`ctxd server: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const dbPath = join(dataDir, "ctxd.db");

  // SPEC v8 section 12's startup integrity: the config existing (just confirmed above) is
  // itself evidence that `ctxd init` ran here before, so a missing database at this point is
  // data that is actually gone, not a machine that was never initialized. Never creates a fresh
  // one over it (SPEC v6 section 12): `ctxd init` is the only command that does.
  if (!existsSync(dbPath)) {
    console.error(
      `ctxd server: ${dbPath} is missing, but ${configPath} exists, suggesting this node was initialized before. ` +
        `Refusing to start over it. Run "ctxd doctor" to check, or "ctxd restore <file>" to recover from a backup.`,
    );
    return 1;
  }

  // The file's existence was just confirmed above, so a throw here means it exists but could not
  // actually be opened (for example, corruption that breaks even the header-level pragma calls
  // openDatabase itself makes, before ever reaching checkDatabaseIntegrity's own quick_check
  // below): the same "unreadable or corrupt" case SPEC v8 section 12 describes.
  let db;
  try {
    db = openDatabase(dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ctxd server: ${message} Run "ctxd doctor" to check, or "ctxd restore <file>" to recover from a backup.`);
    return 1;
  }

  const integrity = checkDatabaseIntegrity(db);
  if (!integrity.ok) {
    console.error(`ctxd server: ${integrity.reason}`);
    db.close();
    return 1;
  }

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

  // Runs once immediately (the offline-catch-up case) and then hourly: cheap enough to check
  // every tick, since digestAlreadyWritten makes every call but the first a no-op.
  let digestInterval: NodeJS.Timeout | undefined;
  if (isFlagOn(flags, "digest")) {
    const human = db.prepare("SELECT client_id FROM clients WHERE name = 'human'").get() as { client_id: string } | undefined;
    if (human) {
      const digestCtx: WriteContext = { db, clock: new HlcClock(node.node_id), nodeId: node.node_id, clientId: human.client_id };
      const tick = (): void => {
        try {
          runDueDigests(digestCtx, config, Date.now());
        } catch (err) {
          console.error(`ctxd server: weekly digest check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      tick();
      digestInterval = setInterval(tick, 3_600_000);
    }
  }

  // Catch-up embedding (SPEC 11.2.1): off by default (writes outside ctxd's own data folder
  // stay off by default -- the model cache -- and this also skips entirely, with no error, if
  // the model was never fetched via `ctxd model fetch`).
  let embedInterval: NodeJS.Timeout | undefined;
  if (isFlagOn(flags, "semantic_search.compute")) {
    let embedding = false;
    const embedCtx: WriteContext = { db, clock: new HlcClock(node.node_id), nodeId: node.node_id, clientId: ensureEmbedClient(db, node.node_id) };
    const tick = (): void => {
      if (embedding) return;
      embedding = true;
      embedPendingEntries(embedCtx, dataDir)
        .catch((err: unknown) => {
          console.error(`ctxd server: embedding tick failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          embedding = false;
        });
    };
    tick();
    embedInterval = setInterval(tick, 30_000);
  }

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    if (pullInterval) clearInterval(pullInterval);
    if (digestInterval) clearInterval(digestInterval);
    if (embedInterval) clearInterval(embedInterval);
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
