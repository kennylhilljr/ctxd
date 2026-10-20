import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config/config.js";
import { requireFlag, resolveFlags } from "../config/flags.js";
import { parsePath } from "../fsview/paths.js";
import { resolveConfigPath } from "./common.js";

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, options: { config: { type: "string" } }, allowPositionals: true, strict: true });
  const uri = positionals[0];
  if (!uri) { console.error("Usage: ctxd open <ctxd://path>"); return 1; }
  parsePath(uri);
  const config = loadConfig(resolveConfigPath({ configPath: values.config }));
  requireFlag(resolveFlags(config), "mirror");
  const path = join(expandHome(config.mirror.dir), uri.slice("ctxd://".length).replace("#", "--"));
  const editor = process.env.EDITOR;
  if (!editor) { console.error("ctxd open: $EDITOR is not set."); return 1; }
  return spawnSync(editor, [path], { stdio: "inherit" }).status ?? 1;
}
