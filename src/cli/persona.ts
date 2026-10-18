/** `ctxd persona issue|rotate|revoke|prefer`: persona tokens (SPEC v6 section 8.4, 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { nowIso } from "../core/time.js";
import { sha256Hex } from "../core/hash.js";
import { deleteSecret, storeSecret, type KeychainOptions } from "../access/keychain.js";

const SERVICE = "ctxd";

function findClient(db: Database.Database, name: string): { client_id: string } | undefined {
  return db.prepare("SELECT client_id FROM clients WHERE name = ?").get(name) as { client_id: string } | undefined;
}

/** Sorted pool ids for the given pool names, or null if any name doesn't resolve. */
function resolvePoolIds(db: Database.Database, names: readonly string[]): string[] | null {
  const ids: string[] = [];
  for (const name of names) {
    const row = db.prepare("SELECT pool_id FROM pools WHERE name = ?").get(name) as { pool_id: string } | undefined;
    if (!row) return null;
    ids.push(row.pool_id);
  }
  return [...new Set(ids)].sort();
}

/** Keychain account for (client, pools) (SPEC v6 section 8.4: service "ctxd", account "<client>/<sorted pool ids>"). */
function account(clientName: string, poolIds: readonly string[]): string {
  return `${clientName}/${poolIds.join(",")}`;
}

export function issuePersona(
  db: Database.Database,
  nodeId: string,
  clientName: string,
  poolNames: readonly string[],
  opts: KeychainOptions = {},
): number {
  const client = findClient(db, clientName);
  if (!client) {
    console.error(`ctxd persona: client "${clientName}" not found.`);
    return 1;
  }
  const poolIds = resolvePoolIds(db, poolNames);
  if (poolIds === null) {
    console.error(`ctxd persona: one or more pools not found: ${poolNames.join(", ")}.`);
    return 1;
  }
  const poolsJson = JSON.stringify(poolIds);
  if (db.prepare("SELECT 1 FROM persona_tokens WHERE client_id = ? AND pools = ? AND revoked_at IS NULL").get(client.client_id, poolsJson)) {
    console.error(`ctxd persona: ${clientName} already has an active token for [${poolIds.join(", ")}]; use rotate.`);
    return 1;
  }
  const raw = randomBytes(32).toString("hex");
  const hash = sha256Hex(raw);
  db.prepare("INSERT INTO persona_tokens (token_hash, client_id, pools, node_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
    hash,
    client.client_id,
    poolsJson,
    nodeId,
    nowIso(),
  );
  storeSecret(SERVICE, account(clientName, poolIds), raw, opts);
  console.log(`ctxd persona issued: ${clientName} -> [${poolIds.join(", ")}]`);
  return 0;
}

export function rotatePersona(
  db: Database.Database,
  nodeId: string,
  clientName: string,
  poolNames: readonly string[],
  opts: KeychainOptions = {},
): number {
  const client = findClient(db, clientName);
  if (!client) {
    console.error(`ctxd persona: client "${clientName}" not found.`);
    return 1;
  }
  const poolIds = resolvePoolIds(db, poolNames);
  if (poolIds === null) {
    console.error(`ctxd persona: one or more pools not found: ${poolNames.join(", ")}.`);
    return 1;
  }
  const poolsJson = JSON.stringify(poolIds);
  const old = db.prepare("SELECT token_hash FROM persona_tokens WHERE client_id = ? AND pools = ? AND revoked_at IS NULL").get(
    client.client_id,
    poolsJson,
  ) as { token_hash: string } | undefined;
  if (!old) {
    console.error(`ctxd persona: no active token for ${clientName} -> [${poolIds.join(", ")}] to rotate.`);
    return 1;
  }
  const raw = randomBytes(32).toString("hex");
  const hash = sha256Hex(raw);
  db.prepare("UPDATE persona_tokens SET revoked_at = ? WHERE token_hash = ?").run(nowIso(), old.token_hash);
  db.prepare(
    "INSERT INTO persona_tokens (token_hash, client_id, pools, node_id, created_at, rotated_from) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(hash, client.client_id, poolsJson, nodeId, nowIso(), old.token_hash);
  storeSecret(SERVICE, account(clientName, poolIds), raw, opts);
  console.log(`ctxd persona rotated: ${clientName} -> [${poolIds.join(", ")}]`);
  return 0;
}

export function revokePersona(db: Database.Database, clientName: string, poolNames: readonly string[], opts: KeychainOptions = {}): number {
  const client = findClient(db, clientName);
  if (!client) {
    console.error(`ctxd persona: client "${clientName}" not found.`);
    return 1;
  }
  const poolIds = resolvePoolIds(db, poolNames);
  if (poolIds === null) {
    console.error(`ctxd persona: one or more pools not found: ${poolNames.join(", ")}.`);
    return 1;
  }
  const poolsJson = JSON.stringify(poolIds);
  const result = db
    .prepare("UPDATE persona_tokens SET revoked_at = ? WHERE client_id = ? AND pools = ? AND revoked_at IS NULL")
    .run(nowIso(), client.client_id, poolsJson);
  if (result.changes === 0) {
    console.error(`ctxd persona: no active token for ${clientName} -> [${poolIds.join(", ")}].`);
    return 1;
  }
  deleteSecret(SERVICE, account(clientName, poolIds), opts);
  console.log(`ctxd persona revoked: ${clientName} -> [${poolIds.join(", ")}]`);
  return 0;
}

export function preferPersona(db: Database.Database, clientName: string, scopeName: string, poolName: string): number {
  const client = findClient(db, clientName);
  if (!client) {
    console.error(`ctxd persona: client "${clientName}" not found.`);
    return 1;
  }
  const scope = db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(scopeName) as { scope_id: string } | undefined;
  if (!scope) {
    console.error(`ctxd persona: scope "${scopeName}" not found.`);
    return 1;
  }
  const pool = db.prepare("SELECT pool_id FROM pools WHERE name = ?").get(poolName) as { pool_id: string } | undefined;
  if (!pool) {
    console.error(`ctxd persona: pool "${poolName}" not found.`);
    return 1;
  }
  db.prepare(
    "INSERT INTO persona_prefs (client_id, scope_id, pool_id) VALUES (?, ?, ?) ON CONFLICT (client_id, scope_id) DO UPDATE SET pool_id = excluded.pool_id",
  ).run(client.client_id, scope.scope_id, pool.pool_id);
  console.log(`ctxd persona prefer: ${clientName} @ ${scopeName} -> ${poolName}`);
  return 0;
}

function poolList(arg: string): string[] {
  return arg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function run(argv: string[]): number {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
    if (!node) {
      console.error("ctxd persona: no node identity found; run ctxd init first.");
      return 1;
    }
    if (sub === "issue" || sub === "rotate") {
      const [clientName, poolsArg] = positionals;
      if (!clientName || !poolsArg) {
        console.error(`Usage: ctxd persona ${sub} <client> <pool>[,<pool>]`);
        return 1;
      }
      const poolNames = poolList(poolsArg);
      return sub === "issue" ? issuePersona(db, node.node_id, clientName, poolNames) : rotatePersona(db, node.node_id, clientName, poolNames);
    }
    if (sub === "revoke") {
      const [clientName, poolsArg] = positionals;
      if (!clientName || !poolsArg) {
        console.error("Usage: ctxd persona revoke <client> <pool>[,<pool>]");
        return 1;
      }
      return revokePersona(db, clientName, poolList(poolsArg));
    }
    if (sub === "prefer") {
      const [clientName, scopeName, poolName] = positionals;
      if (!clientName || !scopeName || !poolName) {
        console.error("Usage: ctxd persona prefer <client> <scope> <pool>");
        return 1;
      }
      return preferPersona(db, clientName, scopeName, poolName);
    }
    console.error(`ctxd persona: unknown subcommand "${sub}". Use issue, rotate, revoke or prefer.`);
    return 2;
  } finally {
    db.close();
  }
}
