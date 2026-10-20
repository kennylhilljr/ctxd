import type Database from "better-sqlite3";
import type { NodeRole, Replication } from "../core/kinds.js";
import { nowIso } from "../core/time.js";
import { mayReplicate } from "../security/policy.js";
import { applyEvent, toWireEvent, type EventRow, type WireEvent } from "./apply.js";

/** POST /v1/pull's request and response bodies (Spec v8 7.1). */
export interface PullRequest {
  node: string;
  vector: Record<string, number>;
  limit: number;
}

export interface PullResponse {
  events: WireEvent[];
  through: Record<string, number>;
  more: boolean;
}

/** `EventRow` plus the one extra column only this query's own replication filter needs. */
type PullRow = EventRow & { scope_replication: Replication };

/**
 * Serve POST /v1/pull (Spec 7.1, 7.2): events the requester hasn't seen, filtered by its role,
 * ordered by (origin_node, origin_seq) exactly as specified (so one origin's backlog can starve
 * another's within a single page; the puller's next call picks up where `more` says to). `through`
 * reports the highest origin_seq *considered* per origin in this page, including events filtered
 * out by the replication policy, so the puller's cursor advances past what it will never receive.
 */
export function servePull(db: Database.Database, requesterRole: NodeRole, req: PullRequest): PullResponse {
  const origins = db.prepare("SELECT origin_node, MAX(origin_seq) AS max_seq FROM events GROUP BY origin_node").all() as {
    origin_node: string;
    max_seq: number;
  }[];
  const candidates = origins.filter((o) => o.max_seq > (req.vector[o.origin_node] ?? 0));
  if (candidates.length === 0) return { events: [], through: {}, more: false };

  const whereParts = candidates.map(() => "(e.origin_node = ? AND e.origin_seq > ?)");
  const whereArgs = candidates.flatMap((o) => [o.origin_node, req.vector[o.origin_node] ?? 0]);
  const rows = db
    .prepare(
      `SELECT e.event_id, e.origin_node, e.origin_seq, e.hlc, e.scope_id, e.entry_id, e.op, e.part, e.parent_revs, e.rev,
              e.client_id, e.session_ref, e.request_id, e.request_hash, e.payload, e.prev, e.payload_hash, e.signature, e.public_key,
              s.replication AS scope_replication
       FROM events e JOIN scopes s ON s.scope_id = e.scope_id
       WHERE ${whereParts.join(" OR ")}
       ORDER BY e.origin_node, e.origin_seq
       LIMIT ?`,
    )
    .all(...whereArgs, req.limit + 1) as PullRow[];

  const more = rows.length > req.limit;
  const page = more ? rows.slice(0, req.limit) : rows;

  const through: Record<string, number> = {};
  const events: WireEvent[] = [];
  for (const row of page) {
    through[row.origin_node] = Math.max(through[row.origin_node] ?? 0, row.origin_seq);
    if (mayReplicate(row.scope_replication, requesterRole)) events.push(toWireEvent(row));
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

    for (const event of body.events) {
      const result = applyEvent(db, event);
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
