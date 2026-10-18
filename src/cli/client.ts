/** `ctxd client add|revoke|tag`: manage client tokens (SPEC v6 section 13). */
import { parseArgs } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir, tokensDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { VENDORS, type Vendor } from "../core/kinds.js";
import { deleteSecret, type KeychainOptions } from "../access/keychain.js";

export function addClient(db: Database.Database, name: string, vendor: Vendor, configPath: string): number {
  if (db.prepare("SELECT 1 FROM clients WHERE name = ?").get(name)) {
    console.error(`ctxd client: "${name}" already exists.`);
    return 1;
  }
  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
  if (!node) {
    console.error("ctxd client: no node identity found; run ctxd init first.");
    return 1;
  }
  const raw = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    newId(),
    name,
    vendor,
    node.node_id,
    hash,
    nowIso(),
  );

  const dir = tokensDir(configPath);
  mkdirSync(dir, { recursive: true });
  const tokenPath = join(dir, `${name}.token`);
  writeFileSync(tokenPath, raw, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);

  console.log(`ctxd client added: ${name} (${vendor})`);
  console.log(`  token: ${tokenPath}`);
  return 0;
}

export function revokeClient(db: Database.Database, name: string, opts: KeychainOptions = {}): number {
  const client = db.prepare("SELECT client_id, revoked_at FROM clients WHERE name = ?").get(name) as
    | { client_id: string; revoked_at: string | null }
    | undefined;
  if (!client) {
    console.error(`ctxd client: "${name}" not found.`);
    return 1;
  }
  if (client.revoked_at) {
    console.error(`ctxd client: "${name}" is already revoked.`);
    return 1;
  }
  const at = nowIso();
  db.prepare("UPDATE clients SET revoked_at = ? WHERE client_id = ?").run(at, client.client_id);

  // Revoking a client must not leave its persona tokens usable: a later auth check that only
  // looks at persona_tokens.revoked_at (and forgets to also check the underlying client) would
  // otherwise keep honoring them.
  const activeTokens = db
    .prepare("SELECT token_hash, pools FROM persona_tokens WHERE client_id = ? AND revoked_at IS NULL")
    .all(client.client_id) as { token_hash: string; pools: string }[];
  for (const t of activeTokens) {
    db.prepare("UPDATE persona_tokens SET revoked_at = ? WHERE token_hash = ?").run(at, t.token_hash);
    const poolIds = JSON.parse(t.pools) as string[];
    deleteSecret("ctxd", `${name}/${poolIds.join(",")}`, opts);
  }

  console.log(`ctxd client revoked: ${name}${activeTokens.length ? ` (and ${activeTokens.length} persona token(s))` : ""}`);
  return 0;
}

export function tagClient(db: Database.Database, name: string, tag: string): number {
  const client = db.prepare("SELECT client_id, tags FROM clients WHERE name = ?").get(name) as
    | { client_id: string; tags: string }
    | undefined;
  if (!client) {
    console.error(`ctxd client: "${name}" not found.`);
    return 1;
  }
  const tags = new Set(JSON.parse(client.tags) as string[]);
  tags.add(tag);
  db.prepare("UPDATE clients SET tags = ? WHERE client_id = ?").run(JSON.stringify([...tags].sort()), client.client_id);
  console.log(`ctxd client tagged: ${name} -> ${tag}`);
  return 0;
}

export function run(argv: string[]): number {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { vendor: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const configPath = resolveConfigPath({ configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    if (sub === "add") {
      const name = positionals[0];
      if (!name) {
        console.error("Usage: ctxd client add <name> --vendor <vendor>");
        return 1;
      }
      const vendor = (values.vendor ?? "other") as Vendor;
      if (!VENDORS.includes(vendor)) {
        console.error(`ctxd client: --vendor must be one of: ${VENDORS.join(", ")}.`);
        return 1;
      }
      return addClient(db, name, vendor, configPath);
    }
    if (sub === "revoke") {
      const name = positionals[0];
      if (!name) {
        console.error("Usage: ctxd client revoke <name>");
        return 1;
      }
      return revokeClient(db, name);
    }
    if (sub === "tag") {
      const [name, tag] = positionals;
      if (!name || !tag) {
        console.error("Usage: ctxd client tag <client> <tag>");
        return 1;
      }
      return tagClient(db, name, tag);
    }
    console.error(`ctxd client: unknown subcommand "${sub}". Use add, revoke or tag.`);
    return 2;
  } finally {
    db.close();
  }
}
