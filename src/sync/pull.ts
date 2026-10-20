import type Database from "better-sqlite3";
import type { NodeRole, Replication } from "../core/kinds.js";
import { nowIso } from "../core/time.js";
import { mayReplicate } from "../security/policy.js";
import { applyEvent, toWireEvent, type EventRow, type WireEvent } from "./apply.js";
import type { SealedKeyProvider } from "../sealed/key-provider.js";
import { decryptSealed, encryptSealed, type CiphertextEnvelope } from "../sealed/crypto.js";
import type { SealedPoolStore } from "../sealed/store.js";

/** POST /v1/pull's request and response bodies (Spec v8 7.1). */
export interface PullRequest {
  node: string;
  vector: Record<string, number>;
  limit: number;
}

export interface PullResponse {
  events: (WireEvent | EncryptedWireEvent)[];
  through: Record<string, number>;
  more: boolean;
}

export interface EncryptedWireEvent { sealed: true; pool_id: string; event_id: string; envelope: CiphertextEnvelope }

/** `EventRow` plus the one extra column only this query's own replication filter needs. */
type PullRow = EventRow & { scope_replication: Replication; sealed_pool_id: string | null };

/**
 * Serve POST /v1/pull (Spec 7.1, 7.2): events the requester hasn't seen, filtered by its role,
 * ordered by (origin_node, origin_seq) exactly as specified (so one origin's backlog can starve
 * another's within a single page; the puller's next call picks up where `more` says to). `through`
 * reports the highest origin_seq *considered* per origin in this page, including events filtered
 * out by the replication policy, so the puller's cursor advances past what it will never receive.
 */
export function servePull(
  db: Database.Database,
  requesterRole: NodeRole,
  req: PullRequest,
  sealedKeys?: SealedKeyProvider,
  sealedStore?: SealedPoolStore,
): PullResponse {
  const selectRows = (source: Database.Database): PullRow[] => {
    const origins = source.prepare("SELECT origin_node, MAX(origin_seq) AS max_seq FROM events GROUP BY origin_node").all() as { origin_node: string; max_seq: number }[];
    const behind = origins.filter((origin) => origin.max_seq > (req.vector[origin.origin_node] ?? 0));
    if (behind.length === 0) return [];
    const where = behind.map(() => "(e.origin_node = ? AND e.origin_seq > ?)").join(" OR ");
    const args = behind.flatMap((origin) => [origin.origin_node, req.vector[origin.origin_node] ?? 0]);
    return source.prepare(
      `SELECT e.event_id, e.schema_version, e.origin_node, e.origin_seq, e.hlc, e.scope_id, e.entry_id, e.op, e.part, e.parent_revs, e.rev,
              e.client_id, e.session_ref, e.request_id, e.request_hash, e.payload, e.prev, e.payload_hash, e.prev_hash, e.signature, e.public_key, e.payload_stripped,
              s.replication AS scope_replication,
              (SELECT pg.pool_id FROM pool_grants pg JOIN pools p ON p.pool_id = pg.pool_id
               WHERE pg.scope_id = e.scope_id AND p.storage = 'sealed' LIMIT 1) AS sealed_pool_id
       FROM events e JOIN scopes s ON s.scope_id = e.scope_id
       WHERE ${where}
       ORDER BY e.origin_node, e.origin_seq`,
    ).all(...args) as PullRow[];
  };

  const rows = selectRows(db);
  if (sealedStore && sealedKeys) {
    const pools = db.prepare(
      `SELECT p.pool_id FROM pools p JOIN pool_enrollments pe ON pe.pool_id = p.pool_id
       WHERE p.storage = 'sealed' AND pe.node_id = ? ORDER BY p.pool_id`,
    ).all(req.node) as { pool_id: string }[];
    for (const pool of pools) {
      for (const row of sealedStore.withPool(pool.pool_id, selectRows)) rows.push({ ...row, sealed_pool_id: pool.pool_id });
    }
  }
  const candidates = rows
    .filter((row) => row.origin_seq > (req.vector[row.origin_node] ?? 0))
    .sort((a, b) => a.origin_node.localeCompare(b.origin_node) || a.origin_seq - b.origin_seq);
  if (candidates.length === 0) return { events: [], through: {}, more: false };

  const more = candidates.length > req.limit;
  const page = candidates.slice(0, req.limit);

  const through: Record<string, number> = {};
  const events: (WireEvent | EncryptedWireEvent)[] = [];
  for (const row of page) {
    through[row.origin_node] = Math.max(through[row.origin_node] ?? 0, row.origin_seq);
    if (!mayReplicate(row.scope_replication, requesterRole)) continue;
    if (row.sealed_pool_id) {
      const enrolled = db.prepare("SELECT 1 FROM pool_enrollments WHERE pool_id = ? AND node_id = ?").get(row.sealed_pool_id, req.node);
      if (!enrolled || !sealedKeys) continue;
      const wire = toWireEvent(row);
      events.push({ sealed: true, pool_id: row.sealed_pool_id, event_id: row.event_id, envelope: encryptSealed(Buffer.from(JSON.stringify(wire)), sealedKeys.get(row.sealed_pool_id), row.event_id) });
    } else events.push(toWireEvent(row));
  }
  return { events, through, more };
}

export interface PullOutcome {
  pulled: number;
  conflicts: number;
  purged: number;
  deferred: number;
  through: Record<string, number>;
}

/**
 * Pull from one peer until `more` is false (Spec 7.1's puller loop), applying each event
 * idempotently and persisting `through` into `sync_state` after every page (not just at the
 * end), so a crash mid-pull resumes from the last completed page rather than from scratch.
 */
export async function pullFromPeer(
  db: Database.Database,
  selfNodeId: string,
  peer: { peerId: string; name: string; url: string; outgoingToken: string },
  fetchImpl: typeof fetch = fetch,
  sealedKeys?: SealedKeyProvider,
  sealedStore?: SealedPoolStore,
): Promise<PullOutcome> {
  const vector = currentVector(db, peer.name);
  let pulled = 0;
  let conflicts = 0;
  let purged = 0;
  let deferred = 0;
  let more = true;
  let lastThrough: Record<string, number> = {};

  while (more) {
    const res = await fetchImpl(new URL("/v1/pull", peer.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${peer.outgoingToken}` },
      body: JSON.stringify({ node: selfNodeId, vector, limit: 500 } satisfies PullRequest),
    });
    if (!res.ok) throw new Error(`pull from ${peer.name} failed: HTTP ${res.status}`);
    const body = (await res.json()) as PullResponse;

    for (const incoming of body.events) {
      const isSealed = "sealed" in incoming && incoming.sealed;
      const event = isSealed
        ? JSON.parse(decryptSealed(incoming.envelope, sealedKeys?.get(incoming.pool_id) ?? Buffer.alloc(0), incoming.event_id).toString("utf8")) as WireEvent
        : incoming as WireEvent;
      if (isSealed && !sealedStore) throw new Error(`sealed event ${incoming.event_id} has no attached-store router`);
      const result = isSealed ? sealedStore!.withPool(incoming.pool_id, (poolDb) => applyEvent(poolDb, event)) : applyEvent(db, event);
      if (result.outcome === "fast-forward") pulled++;
      else if (result.outcome === "conflict-resolved") conflicts++;
      else if (result.outcome === "purge-stripped") purged++;
      else if (result.outcome === "deferred") deferred++;
    }
    storeThrough(db, peer.name, body.through);
    Object.assign(vector, body.through);
    lastThrough = body.through;
    more = body.more;
  }
  // Spec 7.4's tentative-claim check (src/store/claim.ts) reads this: a completed pull counts as
  // "successful" whether or not it carried any new events, so an idle-but-reachable peer still
  // keeps claims on this node out of tentative state.
  db.prepare("UPDATE peers SET last_synced_at = ? WHERE peer_id = ?").run(nowIso(), peer.peerId);
  return { pulled, conflicts, purged, deferred, through: lastThrough };
}

function currentVector(db: Database.Database, peerName: string): Record<string, number> {
  const rows = db.prepare("SELECT origin_node, through_seq FROM sync_state WHERE peer_node = ?").all(peerName) as {
    origin_node: string;
    through_seq: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.origin_node, r.through_seq]));
}

function storeThrough(db: Database.Database, peerName: string, through: Record<string, number>): void {
  const stmt = db.prepare(
    `INSERT INTO sync_state (peer_node, origin_node, through_seq) VALUES (?, ?, ?)
     ON CONFLICT (peer_node, origin_node) DO UPDATE SET through_seq = excluded.through_seq`,
  );
  db.transaction(() => {
    for (const [originNode, seq] of Object.entries(through)) stmt.run(peerName, originNode, seq);
  })();
}
