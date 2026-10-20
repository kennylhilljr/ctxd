/** `ctxd features` / `ctxd features set <name> on|off` (PRD-feature-flags-v1 FF-5, Spec v8 13). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { parseArgs } from "node:util";
import { resolveConfigPath } from "./common.js";
import { configSchema, loadConfig } from "../config/config.js";
import { FLAG_REGISTRY, resolveFlagsDetailed } from "../config/flags.js";

function printList(configPath: string): void {
  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    config = undefined; // no config yet, or unreadable: every flag falls back to its registry default
  }
  for (const r of resolveFlagsDetailed(config, process.env)) {
    console.log(`${r.def.name.padEnd(28)} ${r.value ? "on " : "off"}  (${r.source}, ${r.def.milestone})  ${r.def.description} -- off: ${r.def.offMeans}`);
  }
}

export function setFlag(configPath: string, name: string, on: boolean): number {
  if (!FLAG_REGISTRY.some((def) => def.name === name)) {
    console.error(`ctxd features: unknown flag "${name}". Run ctxd features to list every flag.`);
    return 1;
  }
  if (!existsSync(configPath)) {
    console.error("ctxd features: run ctxd init first.");
    return 1;
  }
  const raw = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const features = { ...((raw.features as Record<string, boolean> | undefined) ?? {}), [name]: on };
  const validated = configSchema.parse({ ...raw, features });
  writeFileSync(configPath, stringify(validated), { mode: 0o600 });
  console.log(`ctxd features: ${name} -> ${on ? "on" : "off"}`);
  return 0;
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, options: { config: { type: "string" } }, allowPositionals: true, strict: true });
  const configPath = resolveConfigPath({ configPath: values.config });
  const [sub, name, state] = positionals;

  if (!sub) {
    printList(configPath);
    return 0;
  }
  if (sub === "set") {
    if (!name || (state !== "on" && state !== "off")) {
      console.error("Usage: ctxd features set <name> on|off");
      return 1;
    }
    return setFlag(configPath, name, state === "on");
  }
  console.error(`ctxd features: unknown subcommand "${sub}".\nUsage: ctxd features [set <name> on|off]`);
  return 1;
}
