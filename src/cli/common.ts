import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { DEFAULT_CONFIG_PATH, expandHome, loadConfig } from "../config/config.js";
import { resolveFlags } from "../config/flags.js";
import { HlcClock } from "../core/hlc.js";
import type { WriteContext } from "../store/write.js";
import type { RequestContext } from "../server/context.js";

export interface DataDirOptions {
  configPath?: string;
  dataDir?: string;
}

/** Resolve the data directory from --data-dir, or from the config file otherwise. */
export function resolveDataDir(opts: DataDirOptions = {}): string {
  if (opts.dataDir) return expandHome(opts.dataDir);
  const config = loadConfig(expandHome(opts.configPath ?? DEFAULT_CONFIG_PATH));
  return expandHome(config.node.data_dir);
}

/** Resolve the config file path from --config, or the default (SPEC v6 section 3). */
export function resolveConfigPath(opts: Pick<DataDirOptions, "configPath"> = {}): string {
  return expandHome(opts.configPath ?? DEFAULT_CONFIG_PATH);
}

/** `~/.config/ctxd/tokens/`, alongside the config file (SPEC v6 section 3). */
export function tokensDir(configPath: string): string {
  return join(dirname(configPath), "tokens");
}

/** A WriteContext for the human client, for CLI commands (flag --unflag, purge) that write through the event path. */
export function resolveHumanWriteContext(db: Database.Database): WriteContext {
  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
  if (!node) throw new Error("no node identity found; run ctxd init first");
  const human = db.prepare("SELECT client_id FROM clients WHERE name = 'human'").get() as { client_id: string } | undefined;
  if (!human) throw new Error("no human client found; run ctxd init first");
  let flags: Map<string, boolean> | undefined;
  const entry = process.argv[1] ?? "";
  if (entry.endsWith("/cli/index.js") || entry.endsWith("/cli/index.ts")) {
    const configAt = process.argv.indexOf("--config");
    const path = expandHome(configAt >= 0 && process.argv[configAt + 1] ? process.argv[configAt + 1]! : DEFAULT_CONFIG_PATH);
    if (existsSync(path)) flags = resolveFlags(loadConfig(path));
  }
  return { db, clock: new HlcClock(node.node_id), nodeId: node.node_id, clientId: human.client_id, flags };
}

/** A RequestContext for the human client, for read-only introspection CLI commands (brief, ls, tree, read) that reuse the MCP tool logic directly. */
export function resolveHumanRequestContext(db: Database.Database): RequestContext {
  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
  if (!node) throw new Error("no node identity found; run ctxd init first");
  const human = db.prepare("SELECT client_id FROM clients WHERE name = 'human'").get() as { client_id: string } | undefined;
  if (!human) throw new Error("no human client found; run ctxd init first");
  return { db, clock: new HlcClock(node.node_id), nodeId: node.node_id, clientId: human.client_id, clientName: "human", vendor: "human", assumedPools: [] };
}
