import { dirname, join } from "node:path";
import { DEFAULT_CONFIG_PATH, expandHome, loadConfig } from "../config/config.js";

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
