/** `ctxd access <client>`: effective access per scope and the reason for each (SPEC v6 section 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { accessLevel, effectiveVendorPolicy, poolsOf, type AccessSnapshot, type ClientInfo, type ScopeInfo } from "../access/level.js";
import { loadAccessSnapshot } from "../store/snapshot.js";

function reasonFor(db: Database.Database, client: ClientInfo, scope: ScopeInfo & { id: string }, snapshot: AccessSnapshot): string {
  if (client.vendor === "human") return "human client";
  if (effectiveVendorPolicy(scope, snapshot) === "local-only" && client.vendor !== "local") return "vendor policy (local-only)";
  if (scope.kind === "me") return "global _me";
  if (scope.kind === "hold") return scope.owner === client.id ? "holding scope (owner)" : "holding scope (not owner)";

  const memberPools = new Set(poolsOf(client, snapshot));
  const grantingPoolIds = snapshot.grants.filter((g) => g.scopeId === scope.id && memberPools.has(g.poolId)).map((g) => g.poolId);
  if (grantingPoolIds.length) {
    const rows = db
      .prepare(`SELECT name FROM pools WHERE pool_id IN (${grantingPoolIds.map(() => "?").join(",")})`)
      .all(...grantingPoolIds) as { name: string }[];
    return `pool ${rows.map((r) => r.name).join(", ")}`;
  }
  const hasTemp = snapshot.temporary.some((t) => t.clientId === client.id && t.scopeId === scope.id && t.expiresAt > Date.now());
  return hasTemp ? "temporary grant" : "no grant";
}

export function showAccess(db: Database.Database, clientName: string): number {
  const row = db.prepare("SELECT client_id, vendor, tags FROM clients WHERE name = ?").get(clientName) as
    | { client_id: string; vendor: string; tags: string }
    | undefined;
  if (!row) {
    console.error(`ctxd access: client "${clientName}" not found.`);
    return 1;
  }
  const client: ClientInfo = { id: row.client_id, vendor: row.vendor as ClientInfo["vendor"], tags: JSON.parse(row.tags) as string[] };
  const snapshot = loadAccessSnapshot(db);
  const scopes = db.prepare("SELECT scope_id, name, kind, owner, vendor_policy FROM scopes ORDER BY name").all() as {
    scope_id: string;
    name: string;
    kind: string;
    owner: string | null;
    vendor_policy: string;
  }[];

  console.log(`access for ${clientName} (${client.vendor}):`);
  for (const s of scopes) {
    const scope: ScopeInfo & { id: string } = {
      id: s.scope_id,
      kind: s.kind as ScopeInfo["kind"],
      owner: s.owner ?? undefined,
      vendorPolicy: s.vendor_policy as ScopeInfo["vendorPolicy"],
    };
    const level = accessLevel(client, scope, snapshot);
    const reason = reasonFor(db, client, scope, snapshot);
    console.log(`  ${s.name.padEnd(24)} ${level.padEnd(8)} ${reason}`);
  }
  return 0;
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const clientName = positionals[0];
  if (!clientName) {
    console.error("Usage: ctxd access <client>");
    return 1;
  }
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return showAccess(db, clientName);
  } finally {
    db.close();
  }
}
