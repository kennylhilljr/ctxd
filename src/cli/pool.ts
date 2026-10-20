/** `ctxd pool create|show|grant|revoke|add-member|remove-member` (SPEC v6 section 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { deterministicId } from "../core/ids.js";
import { appendAclEvent } from "../store/acl.js";
import { GRANT_LEVELS, type AccessLevel } from "../core/kinds.js";
import type { WriteContext } from "../store/write.js";
import { loadConfig } from "../config/config.js";
import { requireFlag, resolveFlags } from "../config/flags.js";
import { KeyHelperProvider } from "../sealed/key-provider.js";
import { SealedPoolStore, SqlCipherDatabaseProvider } from "../sealed/store.js";

function findPool(db: Database.Database, name: string): { pool_id: string } | undefined {
  return db.prepare("SELECT pool_id FROM pools WHERE name = ?").get(name) as { pool_id: string } | undefined;
}

// Excludes the reserved `_system` scope (kind 'system'): it holds acl events only, never
// knowledge content, so it is never a valid pool-grant target (found during /code-review).
function findScope(db: Database.Database, name: string): { scope_id: string } | undefined {
  return db.prepare("SELECT scope_id FROM scopes WHERE name = ? AND kind != 'system'").get(name) as { scope_id: string } | undefined;
}

export function createPool(ctx: WriteContext, name: string, description: string): number {
  if (findPool(ctx.db, name)) {
    console.error(`ctxd pool: "${name}" already exists.`);
    return 1;
  }
  // A pool's id is derived from its name (SPEC v8 4), same reasoning as a scope's.
  const poolId = deterministicId("pool", name);
  appendAclEvent(ctx, poolId, { action: "pool_create", name, description });
  console.log(`ctxd pool created: ${name}`);
  return 0;
}

export function showPool(db: Database.Database, name: string): number {
  const pool = findPool(db, name);
  if (!pool) {
    console.error(`ctxd pool: "${name}" not found.`);
    return 1;
  }
  const grants = db
    .prepare("SELECT s.name AS scope, g.level FROM pool_grants g JOIN scopes s ON s.scope_id = g.scope_id WHERE g.pool_id = ? ORDER BY s.name")
    .all(pool.pool_id) as { scope: string; level: string }[];
  const members = db.prepare("SELECT principal FROM pool_members WHERE pool_id = ? ORDER BY principal").all(pool.pool_id) as {
    principal: string;
  }[];
  console.log(`pool: ${name}`);
  console.log(`  grants: ${grants.length ? grants.map((g) => `${g.scope}:${g.level}`).join(", ") : "(none)"}`);
  console.log(`  members: ${members.length ? members.map((m) => m.principal).join(", ") : "(none)"}`);
  return 0;
}

export function grantPool(ctx: WriteContext, pool: string, scope: string, level: Exclude<AccessLevel, "none">): number {
  const { db } = ctx;
  const poolRow = findPool(db, pool);
  if (!poolRow) {
    console.error(`ctxd pool: "${pool}" not found.`);
    return 1;
  }
  const scopeRow = findScope(db, scope);
  if (!scopeRow) {
    console.error(`ctxd pool: scope "${scope}" not found.`);
    return 1;
  }
  appendAclEvent(ctx, poolRow.pool_id, { action: "pool_grant", scope_id: scopeRow.scope_id, level });
  console.log(`ctxd pool grant: ${pool} -> ${scope} (${level})`);
  return 0;
}

export function revokePoolGrant(ctx: WriteContext, pool: string, scope: string): number {
  const { db } = ctx;
  const poolRow = findPool(db, pool);
  if (!poolRow) {
    console.error(`ctxd pool: "${pool}" not found.`);
    return 1;
  }
  const scopeRow = findScope(db, scope);
  if (!scopeRow) {
    console.error(`ctxd pool: scope "${scope}" not found.`);
    return 1;
  }
  if (!db.prepare("SELECT 1 FROM pool_grants WHERE pool_id = ? AND scope_id = ?").get(poolRow.pool_id, scopeRow.scope_id)) {
    console.error(`ctxd pool: "${pool}" had no grant on "${scope}".`);
    return 1;
  }
  appendAclEvent(ctx, poolRow.pool_id, { action: "pool_revoke", scope_id: scopeRow.scope_id });
  console.log(`ctxd pool revoke: ${pool} -/-> ${scope}`);
  return 0;
}

function principalFor(db: Database.Database, clientOrTag: string, isTag: boolean): string | null {
  if (isTag) return `tag:${clientOrTag}`;
  const client = db.prepare("SELECT client_id FROM clients WHERE name = ?").get(clientOrTag) as { client_id: string } | undefined;
  return client ? `client:${client.client_id}` : null;
}

export function addMember(ctx: WriteContext, pool: string, clientOrTag: string, isTag: boolean): number {
  const { db } = ctx;
  const poolRow = findPool(db, pool);
  if (!poolRow) {
    console.error(`ctxd pool: "${pool}" not found.`);
    return 1;
  }
  const principal = principalFor(db, clientOrTag, isTag);
  if (!principal) {
    console.error(`ctxd pool: client "${clientOrTag}" not found.`);
    return 1;
  }
  appendAclEvent(ctx, poolRow.pool_id, { action: "pool_add_member", principal });
  console.log(`ctxd pool add-member: ${pool} += ${principal}`);
  return 0;
}

export function removeMember(ctx: WriteContext, pool: string, clientOrTag: string, isTag: boolean): number {
  const { db } = ctx;
  const poolRow = findPool(db, pool);
  if (!poolRow) {
    console.error(`ctxd pool: "${pool}" not found.`);
    return 1;
  }
  const principal = principalFor(db, clientOrTag, isTag);
  if (!principal) {
    console.error(`ctxd pool: client "${clientOrTag}" not found.`);
    return 1;
  }
  appendAclEvent(ctx, poolRow.pool_id, { action: "pool_remove_member", principal });
  console.log(`ctxd pool remove-member: ${pool} -= ${principal}`);
  return 0;
}

export function run(argv: string[]): number {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      description: { type: "string" },
      level: { type: "string" },
      tag: { type: "boolean" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const config = loadConfig(resolveConfigPath({ configPath: values.config }));
  const flags = resolveFlags(config);
  const db = openDatabase(join(dataDir, "ctxd.db"));
  const humanContext = (): WriteContext => {
    const ctx = resolveHumanWriteContext(db);
    ctx.flags = flags;
    return ctx;
  };
  try {
    switch (sub) {
      case "create": {
        const name = positionals[0];
        if (!name) {
          console.error("Usage: ctxd pool create <name> [--description <text>]");
          return 1;
        }
        return createPool(humanContext(), name, values.description ?? "");
      }
      case "show": {
        const name = positionals[0];
        if (!name) {
          console.error("Usage: ctxd pool show <name>");
          return 1;
        }
        return showPool(db, name);
      }
      case "grant": {
        const [pool, scope] = positionals;
        const level = values.level as Exclude<AccessLevel, "none"> | undefined;
        if (!pool || !scope || !level) {
          console.error("Usage: ctxd pool grant <pool> <scope> --level read|propose|write");
          return 1;
        }
        if (!GRANT_LEVELS.includes(level)) {
          console.error(`ctxd pool: --level must be one of: ${GRANT_LEVELS.join(", ")}.`);
          return 1;
        }
        return grantPool(humanContext(), pool, scope, level);
      }
      case "revoke": {
        const [pool, scope] = positionals;
        if (!pool || !scope) {
          console.error("Usage: ctxd pool revoke <pool> <scope>");
          return 1;
        }
        return revokePoolGrant(humanContext(), pool, scope);
      }
      case "add-member": {
        const [pool, clientOrTag] = positionals;
        if (!pool || !clientOrTag) {
          console.error("Usage: ctxd pool add-member <pool> <client> | --tag <tag>");
          return 1;
        }
        return addMember(humanContext(), pool, clientOrTag, values.tag === true);
      }
      case "remove-member": {
        const [pool, clientOrTag] = positionals;
        if (!pool || !clientOrTag) {
          console.error("Usage: ctxd pool remove-member <pool> <client> | --tag <tag>");
          return 1;
        }
        return removeMember(humanContext(), pool, clientOrTag, values.tag === true);
      }
      case "seal": {
        requireFlag(flags, "sealed_pools");
        const name = positionals[0];
        const pool = name ? findPool(db, name) : undefined;
        if (!name || !pool) { console.error("Usage: ctxd pool seal <pool>"); return 1; }
        const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string };
        const store = new SealedPoolStore(db, dataDir, new KeyHelperProvider(config.sealed.key_helper), new SqlCipherDatabaseProvider(), config.sealed.unlock_minutes);
        const file = store.seal(pool.pool_id, node.node_id);
        appendAclEvent(humanContext(), pool.pool_id, { action: "pool_seal", sealed_file: file });
        appendAclEvent(humanContext(), pool.pool_id, { action: "pool_enroll", node_id: node.node_id });
        console.log(`ctxd pool sealed: ${name} (${file})`);
        return 0;
      }
      case "enroll": {
        requireFlag(flags, "sealed_pools");
        const [name, nodeName] = positionals;
        const pool = name ? findPool(db, name) : undefined;
        const node = nodeName ? db.prepare("SELECT node_id FROM nodes WHERE name = ? OR node_id = ?").get(nodeName, nodeName) as { node_id: string } | undefined : undefined;
        if (!name || !nodeName || !pool || !node) { console.error("Usage: ctxd pool enroll <pool> <node>"); return 1; }
        const store = new SealedPoolStore(db, dataDir, new KeyHelperProvider(config.sealed.key_helper), new SqlCipherDatabaseProvider(), config.sealed.unlock_minutes);
        store.enroll(pool.pool_id, node.node_id);
        appendAclEvent(humanContext(), pool.pool_id, { action: "pool_enroll", node_id: node.node_id });
        console.log(`ctxd pool enrolled: ${name} -> ${nodeName}`);
        return 0;
      }
      case "lock": {
        requireFlag(flags, "sealed_pools");
        const name = positionals[0];
        const pool = name ? findPool(db, name) : undefined;
        if (!name || !pool) { console.error("Usage: ctxd pool lock <pool>"); return 1; }
        const store = new SealedPoolStore(db, dataDir, new KeyHelperProvider(config.sealed.key_helper), new SqlCipherDatabaseProvider(), config.sealed.unlock_minutes);
        store.lock(pool.pool_id);
        console.log(`ctxd pool locked: ${name}`);
        return 0;
      }
      default:
        console.error(`ctxd pool: unknown subcommand "${sub}". Use create, show, grant, revoke, add-member, remove-member, seal, enroll or lock.`);
        return 2;
    }
  } finally {
    db.close();
  }
}
