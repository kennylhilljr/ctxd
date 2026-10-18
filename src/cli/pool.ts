/** `ctxd pool create|show|grant|revoke|add-member|remove-member` (SPEC v6 section 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { GRANT_LEVELS, type AccessLevel } from "../core/kinds.js";

function findPool(db: Database.Database, name: string): { pool_id: string } | undefined {
  return db.prepare("SELECT pool_id FROM pools WHERE name = ?").get(name) as { pool_id: string } | undefined;
}

function findScope(db: Database.Database, name: string): { scope_id: string } | undefined {
  return db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(name) as { scope_id: string } | undefined;
}

export function createPool(db: Database.Database, name: string, description: string): number {
  if (findPool(db, name)) {
    console.error(`ctxd pool: "${name}" already exists.`);
    return 1;
  }
  db.prepare("INSERT INTO pools (pool_id, name, description, created_at) VALUES (?, ?, ?, ?)").run(newId(), name, description, nowIso());
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

export function grantPool(db: Database.Database, pool: string, scope: string, level: Exclude<AccessLevel, "none">): number {
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
  db.prepare(
    "INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, ?) ON CONFLICT (pool_id, scope_id) DO UPDATE SET level = excluded.level",
  ).run(poolRow.pool_id, scopeRow.scope_id, level);
  console.log(`ctxd pool grant: ${pool} -> ${scope} (${level})`);
  return 0;
}

export function revokePoolGrant(db: Database.Database, pool: string, scope: string): number {
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
  const result = db.prepare("DELETE FROM pool_grants WHERE pool_id = ? AND scope_id = ?").run(poolRow.pool_id, scopeRow.scope_id);
  if (result.changes === 0) {
    console.error(`ctxd pool: "${pool}" had no grant on "${scope}".`);
    return 1;
  }
  console.log(`ctxd pool revoke: ${pool} -/-> ${scope}`);
  return 0;
}

function principalFor(db: Database.Database, clientOrTag: string, isTag: boolean): string | null {
  if (isTag) return `tag:${clientOrTag}`;
  const client = db.prepare("SELECT client_id FROM clients WHERE name = ?").get(clientOrTag) as { client_id: string } | undefined;
  return client ? `client:${client.client_id}` : null;
}

export function addMember(db: Database.Database, pool: string, clientOrTag: string, isTag: boolean): number {
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
  db.prepare("INSERT OR IGNORE INTO pool_members (pool_id, principal) VALUES (?, ?)").run(poolRow.pool_id, principal);
  console.log(`ctxd pool add-member: ${pool} += ${principal}`);
  return 0;
}

export function removeMember(db: Database.Database, pool: string, clientOrTag: string, isTag: boolean): number {
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
  db.prepare("DELETE FROM pool_members WHERE pool_id = ? AND principal = ?").run(poolRow.pool_id, principal);
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
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    switch (sub) {
      case "create": {
        const name = positionals[0];
        if (!name) {
          console.error("Usage: ctxd pool create <name> [--description <text>]");
          return 1;
        }
        return createPool(db, name, values.description ?? "");
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
        return grantPool(db, pool, scope, level);
      }
      case "revoke": {
        const [pool, scope] = positionals;
        if (!pool || !scope) {
          console.error("Usage: ctxd pool revoke <pool> <scope>");
          return 1;
        }
        return revokePoolGrant(db, pool, scope);
      }
      case "add-member": {
        const [pool, clientOrTag] = positionals;
        if (!pool || !clientOrTag) {
          console.error("Usage: ctxd pool add-member <pool> <client> | --tag <tag>");
          return 1;
        }
        return addMember(db, pool, clientOrTag, values.tag === true);
      }
      case "remove-member": {
        const [pool, clientOrTag] = positionals;
        if (!pool || !clientOrTag) {
          console.error("Usage: ctxd pool remove-member <pool> <client> | --tag <tag>");
          return 1;
        }
        return removeMember(db, pool, clientOrTag, values.tag === true);
      }
      default:
        console.error(`ctxd pool: unknown subcommand "${sub}". Use create, show, grant, revoke, add-member or remove-member.`);
        return 2;
    }
  } finally {
    db.close();
  }
}
