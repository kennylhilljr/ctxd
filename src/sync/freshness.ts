import type Database from "better-sqlite3";

const STALE_AFTER_MS = 10 * 60_000;

export interface SyncFreshness {
  /** Whether this node has any non-revoked peer configured at all. */
  hasPeers: boolean;
  /** The most recent successful pull from any peer (`peers.last_synced_at`), or null if never. */
  lastSyncedAt: string | null;
  /**
   * True only when this node has at least one peer and none has completed a successful pull in
   * the last 10 minutes. A node with no peers at all has nothing to be partitioned from, so it
   * is never stale (every claim and brief behaves exactly as it did before sync existed).
   */
  stale: boolean;
}

/**
 * Shared by the tentative-claim check (Spec 7.4, `src/store/claim.ts`) and the brief header's
 * sync freshness / stale-sync notice (M3 slice 7): both are "has this node had a successful sync
 * recently," just surfaced in different places, so there is exactly one query and one threshold.
 */
export function syncFreshness(db: Database.Database): SyncFreshness {
  const row = db.prepare("SELECT COUNT(*) AS n, MAX(last_synced_at) AS latest FROM peers WHERE revoked_at IS NULL").get() as {
    n: number;
    latest: string | null;
  };
  const hasPeers = row.n > 0;
  const stale = hasPeers && (row.latest === null || Date.now() - Date.parse(row.latest) >= STALE_AFTER_MS);
  return { hasPeers, lastSyncedAt: row.latest, stale };
}
