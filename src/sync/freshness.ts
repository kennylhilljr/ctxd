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

export interface PeerSyncAge {
  name: string;
  /** `peers.last_synced_at`, or null if this peer has never completed a successful pull. */
  lastSyncedAt: string | null;
  /** Hours since `lastSyncedAt`, or since the peer was added if it has never synced. */
  ageHours: number;
  stale: boolean;
}

/**
 * Per-peer "last sync age" (W3, SPEC v8 section 12's "last sync age" doctor bullet): each
 * non-revoked peer's own `last_synced_at`, not the single most-recent-of-any-peer `syncFreshness`
 * reports. A peer that has never synced uses `created_at` so a brand new peer is not immediately
 * reported stale.
 */
export function peerSyncAges(db: Database.Database, staleHours: number, now: number = Date.now()): PeerSyncAge[] {
  const rows = db.prepare("SELECT name, last_synced_at, created_at FROM peers WHERE revoked_at IS NULL ORDER BY name").all() as {
    name: string;
    last_synced_at: string | null;
    created_at: string;
  }[];
  return rows.map((r) => {
    const since = r.last_synced_at ?? r.created_at;
    const ageHours = (now - Date.parse(since)) / 3_600_000;
    return { name: r.name, lastSyncedAt: r.last_synced_at, ageHours, stale: ageHours >= staleHours };
  });
}

/**
 * How many of this node's own events at least one active peer has not yet received (W3): per
 * origin, the slowest active peer's served watermark (`peer_watermarks`, a peer with no row yet
 * counts as 0) against the highest origin_seq this node actually has. Zero with no active peers,
 * since there is then nothing to be unsynced from.
 */
export function countUnsynced(db: Database.Database): number {
  const peerIds = (db.prepare("SELECT peer_id FROM peers WHERE revoked_at IS NULL").all() as { peer_id: string }[]).map((r) => r.peer_id);
  if (peerIds.length === 0) return 0;

  const origins = db.prepare("SELECT origin_node, MAX(origin_seq) AS max_seq FROM events GROUP BY origin_node").all() as {
    origin_node: string;
    max_seq: number;
  }[];
  const watermarkStmt = db.prepare("SELECT through_seq FROM peer_watermarks WHERE peer_id = ? AND origin_node = ?");

  let unsynced = 0;
  for (const origin of origins) {
    let minServed = origin.max_seq;
    for (const peerId of peerIds) {
      const row = watermarkStmt.get(peerId, origin.origin_node) as { through_seq: number } | undefined;
      minServed = Math.min(minServed, row?.through_seq ?? 0);
    }
    unsynced += Math.max(0, origin.max_seq - minServed);
  }
  return unsynced;
}
