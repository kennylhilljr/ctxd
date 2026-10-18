import type Database from "better-sqlite3";
import type { AccessSnapshot, ClientInfo, PoolGrant, ScopeInfo, TemporaryGrant } from "../access/level.js";
import type { AccessLevel, ScopeKind, Vendor, VendorPolicy } from "../core/kinds.js";

/**
 * Bridges access/level.ts's pure functions to the real database: loads clients, scopes and the
 * access metadata snapshot (pools, grants, members, temporary grants) they need.
 */

interface ClientRow {
  client_id: string;
  vendor: Vendor;
  tags: string;
  revoked_at: string | null;
}

export function loadClient(db: Database.Database, clientId: string): ClientInfo | null {
  const row = db
    .prepare("SELECT client_id, vendor, tags, revoked_at FROM clients WHERE client_id = ?")
    .get(clientId) as ClientRow | undefined;
  if (!row || row.revoked_at !== null) return null;
  return { id: row.client_id, vendor: row.vendor, tags: JSON.parse(row.tags) as string[] };
}

interface ScopeRow {
  scope_id: string;
  name: string;
  kind: ScopeKind;
  owner: string | null;
  vendor_policy: VendorPolicy;
}

function toScopeInfo(row: ScopeRow): ScopeInfo & { id: string; name: string } {
  return { id: row.scope_id, name: row.name, kind: row.kind, owner: row.owner ?? undefined, vendorPolicy: row.vendor_policy };
}

export function loadScopeByName(db: Database.Database, name: string): (ScopeInfo & { id: string; name: string }) | null {
  const row = db.prepare("SELECT scope_id, name, kind, owner, vendor_policy FROM scopes WHERE name = ?").get(name) as
    | ScopeRow
    | undefined;
  return row ? toScopeInfo(row) : null;
}

export function loadScopeById(db: Database.Database, id: string): (ScopeInfo & { id: string; name: string }) | null {
  const row = db.prepare("SELECT scope_id, name, kind, owner, vendor_policy FROM scopes WHERE scope_id = ?").get(id) as
    | ScopeRow
    | undefined;
  return row ? toScopeInfo(row) : null;
}

export function loadAccessSnapshot(db: Database.Database): AccessSnapshot {
  const grants: PoolGrant[] = (
    db.prepare("SELECT pool_id, scope_id, level FROM pool_grants").all() as {
      pool_id: string;
      scope_id: string;
      level: Exclude<AccessLevel, "none">;
    }[]
  ).map((r) => ({ poolId: r.pool_id, scopeId: r.scope_id, level: r.level }));

  const members = new Map<string, string[]>();
  for (const r of db.prepare("SELECT pool_id, principal FROM pool_members").all() as {
    pool_id: string;
    principal: string;
  }[]) {
    members.set(r.pool_id, [...(members.get(r.pool_id) ?? []), r.principal]);
  }

  const poolVendorDefaults = new Map<string, VendorPolicy>();
  for (const r of db.prepare("SELECT pool_id, defaults FROM pools").all() as { pool_id: string; defaults: string }[]) {
    const defaults = JSON.parse(r.defaults) as { vendor_policy?: VendorPolicy };
    if (defaults.vendor_policy) poolVendorDefaults.set(r.pool_id, defaults.vendor_policy);
  }

  const temporary: TemporaryGrant[] = (
    db.prepare("SELECT client_id, scope_id, level, expires_at FROM client_grants").all() as {
      client_id: string;
      scope_id: string;
      level: Exclude<AccessLevel, "none">;
      expires_at: string;
    }[]
  ).map((r) => ({ clientId: r.client_id, scopeId: r.scope_id, level: r.level, expiresAt: Date.parse(r.expires_at) }));

  return { grants, members, poolVendorDefaults, temporary };
}
