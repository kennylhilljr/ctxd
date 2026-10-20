import type Database from "better-sqlite3";

/**
 * Shared by the apply direction (src/inbox/pull.ts) and the publish direction
 * (src/inbox/publishBriefs.ts): "Sealed pools never touch the inbox, in either direction. local-
 * only and home scopes are never published" (M7 kickoff section 2; MI-7).
 */
export interface ScopeExclusionRow {
  id: string;
  replication: string;
  vendorPolicy: string;
}

export function loadScopeExclusionRow(db: Database.Database, name: string): ScopeExclusionRow | null {
  const row = db.prepare("SELECT scope_id, replication, vendor_policy FROM scopes WHERE name = ?").get(name) as
    | { scope_id: string; replication: string; vendor_policy: string }
    | undefined;
  return row ? { id: row.scope_id, replication: row.replication, vendorPolicy: row.vendor_policy } : null;
}

/**
 * A sealed pool's scopes are excluded by construction (they live only inside the pool's own
 * encrypted file, never in this query against the main database); `home` replication and
 * `local-only` vendor policy are excluded explicitly, here.
 */
export function exclusionReason(scope: ScopeExclusionRow): string | null {
  if (scope.replication === "home") return "scope is home replication-only";
  if (scope.vendorPolicy === "local-only") return "scope is local-only";
  return null;
}
