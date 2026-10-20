/** `ctxd node add-peer|revoke`: manage sync peers (Spec v8 7.1, 13). */
import { parseArgs } from "node:util";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir, tokensDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { newToken } from "../core/hash.js";
import { configSchema, loadConfig } from "../config/config.js";
import { parse, stringify } from "smol-toml";
import { probeServer } from "./mcp.js";

export interface AddPeerOptions {
  role: "home" | "roaming";
  token?: string;
}

/**
 * Registers a machine to sync with: generates the token this peer must present to pull from us
 * (hash stored, raw token written to a local file to copy onto the peer's machine), and stores
 * `token` (the token we present when pulling from the peer) if already known. A peer added
 * without `token` has `outgoing_token` NULL until a later call supplies it (SPEC v8 7.1):
 * pulling from it fails until then, but it can already pull from us.
 *
 * Establishing a peer relationship is three calls, since each side's token can only exist once
 * the other side has generated it: A adds B (no token yet); B adds A, supplying the token A just
 * printed; A re-runs add-peer for B, supplying the token B just printed. That third call is this
 * function's one update path: an existing peer with `--token` given updates only its
 * `outgoing_token` (the already-issued `incoming_token_hash` is never regenerated, so it never
 * invalidates a token already handed to that peer); an existing peer with no `--token` is left
 * alone and refused, since there would be nothing to do.
 */
export function addPeer(db: Database.Database, name: string, url: string, opts: AddPeerOptions, configPath: string): number {
  const existing = db.prepare("SELECT peer_id, role FROM peers WHERE name = ?").get(name) as { peer_id: string; role: string } | undefined;
  if (existing) {
    if (!opts.token) {
      console.error(`ctxd node: peer "${name}" already exists. Pass --token to update its outgoing token.`);
      return 1;
    }
    if (existing.role !== opts.role) {
      console.error(`ctxd node: peer "${name}" is registered as "${existing.role}", not "${opts.role}". This call only updates its outgoing token; role is not mutable here.`);
      return 1;
    }
    db.prepare("UPDATE peers SET outgoing_token = ? WHERE peer_id = ?").run(opts.token, existing.peer_id);
    console.log(`ctxd node: peer ${name}: outgoing token updated.`);
    return 0;
  }
  const { raw, hash } = newToken();
  db.prepare(
    "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, outgoing_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(newId(), name, url, opts.role, hash, opts.token ?? null, nowIso());

  const dir = tokensDir(configPath);
  mkdirSync(dir, { recursive: true });
  const tokenPath = join(dir, `peer-${name}.token`);
  writeFileSync(tokenPath, raw);
  chmodSync(tokenPath, 0o600);

  console.log(`ctxd node: peer added: ${name} (${opts.role}) at ${url}`);
  console.log(`  token for ${name} to use when it pulls from us: ${tokenPath}`);
  console.log(`  copy that file's contents to the ${name} machine and run there:`);
  console.log(`    ctxd node add-peer <this node's name> <this node's url> --role <this node's role> --token <copied token>`);
  if (!opts.token) {
    console.log(`  no --token given: pulling from ${name} will fail until this node's own add-peer call for ${name} supplies one.`);
  }
  return 0;
}

export function revokePeer(db: Database.Database, name: string): number {
  const peer = db.prepare("SELECT peer_id, revoked_at FROM peers WHERE name = ?").get(name) as { peer_id: string; revoked_at: string | null } | undefined;
  if (!peer) {
    console.error(`ctxd node: peer "${name}" not found.`);
    return 1;
  }
  if (peer.revoked_at) {
    console.error(`ctxd node: peer "${name}" is already revoked.`);
    return 1;
  }
  db.prepare("UPDATE peers SET revoked_at = ? WHERE peer_id = ?").run(nowIso(), peer.peer_id);
  console.log(`ctxd node: peer revoked: ${name}`);
  return 0;
}

export async function adoptNode(
  db: Database.Database,
  configPath: string,
  newName: string,
  probe: (listen: string) => Promise<boolean> = probeServer,
): Promise<number> {
  const config = loadConfig(configPath);
  if (await probe(config.mcp.listen)) {
    console.error("ctxd node adopt: the server is running. Stop it before adopting this data directory.");
    return 1;
  }
  const node = db.prepare("SELECT node_id, name FROM nodes").all() as { node_id: string; name: string }[];
  if (node.length !== 1) {
    console.error("ctxd node adopt: expected exactly one local node identity.");
    return 1;
  }
  if (node[0]!.name === newName && config.node.name === newName) {
    console.log(`ctxd node adopt: already named ${newName}; node id ${node[0]!.node_id} is unchanged.`);
    return 0;
  }
  if (db.prepare("SELECT 1 FROM peers WHERE name = ? AND revoked_at IS NULL").get(newName)) {
    console.error(`ctxd node adopt: "${newName}" collides with an active peer name.`);
    return 1;
  }
  const raw = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const validated = configSchema.parse({ ...raw, node: { ...(raw.node as Record<string, unknown>), name: newName } });
  const temp = join(dirname(configPath), `.ctxd-adopt-${process.pid}.toml`);
  writeFileSync(temp, stringify(validated), { mode: 0o600 });
  db.transaction(() => {
    db.prepare("UPDATE nodes SET name = ? WHERE node_id = ?").run(newName, node[0]!.node_id);
    renameSync(temp, configPath);
  })();
  console.log(`ctxd node adopted: ${newName}; node id ${node[0]!.node_id} preserved.`);
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { role: { type: "string" }, token: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const configPath = resolveConfigPath({ configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    if (sub === "add-peer") {
      const [name, url] = positionals;
      if (!name || !url) {
        console.error("Usage: ctxd node add-peer <name> <url> --role <home|roaming> [--token <token>]");
        return 1;
      }
      if (values.role !== "home" && values.role !== "roaming") {
        console.error("ctxd node: --role must be \"home\" or \"roaming\".");
        return 1;
      }
      return addPeer(db, name, url, { role: values.role, token: values.token }, configPath);
    }
    if (sub === "revoke") {
      const name = positionals[0];
      if (!name) {
        console.error("Usage: ctxd node revoke <name>");
        return 1;
      }
      return revokePeer(db, name);
    }
    if (sub === "adopt") {
      const name = positionals[0];
      if (!name) { console.error("Usage: ctxd node adopt <new-name>"); return 1; }
      return await adoptNode(db, configPath, name);
    }
    console.error(`ctxd node: unknown subcommand "${sub}". Use add-peer, revoke or adopt.`);
    return 2;
  } finally {
    db.close();
  }
}
