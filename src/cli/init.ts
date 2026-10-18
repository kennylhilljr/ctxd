/** `ctxd init`: create config, data dir, node identity and the human client (SPEC v6 13, 1515, 1577). */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "smol-toml";
import { DEFAULT_CONFIG_PATH, configSchema, expandHome } from "../config/config.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { sha256Hex } from "../core/hash.js";
import { openDatabase } from "../store/db.js";

export interface InitOptions {
  configPath?: string;
  name?: string;
  role?: "home" | "roaming";
  dataDir?: string;
}

function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const hash = sha256Hex(raw);
  return { raw, hash };
}

export function runInit(opts: InitOptions = {}): number {
  const configPath = expandHome(opts.configPath ?? DEFAULT_CONFIG_PATH);
  const dataDir = expandHome(opts.dataDir ?? "~/Library/Application Support/ctxd");
  const dbPath = join(dataDir, "ctxd.db");

  if (existsSync(configPath)) {
    console.error(`ctxd init: already initialized (config exists at ${configPath}).`);
    return 1;
  }
  if (existsSync(dbPath)) {
    console.error(`ctxd init: already initialized (database exists at ${dbPath}). ctxd init never writes over an existing database.`);
    return 1;
  }

  let config;
  try {
    config = configSchema.parse({
      node: { name: opts.name ?? hostname(), role: opts.role ?? "home", data_dir: dataDir },
    });
  } catch (err) {
    console.error(`ctxd init: invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  mkdirSync(dataDir, { recursive: true });

  // config.toml is written last and is the "already initialized" sentinel above: everything
  // else below must succeed first, so a failed init never leaves a sentinel a retry can't get
  // past (the database path check above is the spec-mandated sentinel; this one is ours).
  const db = openDatabase(dbPath, { create: true });
  try {
    const nodeId = newId();
    const { raw, hash } = newToken();
    db.transaction(() => {
      db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, ?, ?, ?)").run(
        nodeId,
        config.node.name,
        config.node.role,
        nowIso(),
      );
      // The node, the human client and _me are bootstrapped directly: there is no prior node,
      // client or _system scope yet to author an `acl` event for them (SPEC v6 section 4).
      // Flagged for SPEC-v7 as a genesis exception to ADR 0002 ("never mutate materialized
      // state without an event"), which otherwise governs every later write.
      db.prepare(
        "INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, '_me', 'me', 'all', 'any', ?)",
      ).run(newId(), nowIso());
      db.prepare(
        "INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)",
      ).run(newId(), nodeId, hash, nowIso());
    })();

    const tokenDir = join(dirname(configPath), "tokens");
    mkdirSync(tokenDir, { recursive: true });
    const tokenPath = join(tokenDir, "human.token");
    writeFileSync(tokenPath, raw, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, stringify(config), { mode: 0o600 });
    chmodSync(configPath, 0o600);

    console.log(`ctxd initialized.`);
    console.log(`  config:   ${configPath}`);
    console.log(`  data dir: ${dataDir}`);
    console.log(`  database: ${dbPath}`);
    console.log(`  node:     ${config.node.name} (${config.node.role})`);
    console.log(`  token:    ${tokenPath}`);
    return 0;
  } finally {
    db.close();
  }
}

/** Parses `ctxd init` CLI arguments and runs it. */
export function run(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      role: { type: "string" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    strict: true,
  });
  if (values.role !== undefined && values.role !== "home" && values.role !== "roaming") {
    console.error(`ctxd init: --role must be "home" or "roaming", got "${values.role}".`);
    return 1;
  }
  return runInit({
    name: values.name,
    role: values.role as "home" | "roaming" | undefined,
    dataDir: values["data-dir"],
    configPath: values.config,
  });
}
