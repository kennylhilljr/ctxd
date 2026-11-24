import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { NodeRole, Replication } from "../core/kinds.js";
import { nowIso } from "../core/time.js";
import { mayReplicate } from "../security/policy.js";
import { redactSecrets, sanitize } from "../security/redact.js";
import { applyEvent, toWireEvent, type ApplyResult, type EventRow, type WireEvent } from "./apply.js";
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
  /** Events refused this pull (new or retried) and kept in `sync_rejections` for a later retry. */
  rejected: number;
  through: Record<string, number>;
}

type IncomingItem = WireEvent | EncryptedWireEvent;
type Tally = Omit<PullOutcome, "through">;

/**
 * A failure of the local database itself (busy, locked, full disk, I/O), as opposed to a refusal
 * of one event. These still abort the pull without advancing the watermark, so a sick database
 * can never make good events get skipped. A constraint violation is about the event, not the disk.
 */
export function isEnvironmentalFailure(err: unknown): boolean {
  // Matched by shape, not `instanceof`: sealed pools run on a different SQLite driver whose
  // SqliteError is a different class.
  if (!(err instanceof Error) || err.name !== "SqliteError") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_") && !code.startsWith("SQLITE_CONSTRAINT");
}

/**
 * Pull from one peer until `more` is false (Spec 7.1's puller loop), applying each event
 * idempotently and persisting `through` into `sync_state` after every page (not just at the
 * end), so a crash mid-pull resumes from the last completed page rather than from scratch.
 *
 * An event that fails to apply (bad signature, a peer-binding refusal, a validation in
 * `applyEvent`, a sealed envelope that won't decrypt) is recorded in `sync_rejections` with its
 * reason and the item as received, and the pull moves on, so one bad event cannot stall
 * replication from this peer (#74). Rejected items are retried at the start of every later pull
 * from the same peer, since some heal on their own (an origin key pinned later, a sealed pool key
 * that arrives later); a row is deleted once its retry applies. Environmental database failures
 * (`isEnvironmentalFailure`) are not rejections: they abort the pull as before.
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
  // A row with only one of the two identity columns set still counts as key-bound (fail closed).
  const peerIdentity = db.prepare("SELECT remote_node_id, remote_public_key FROM peers WHERE peer_id = ?").get(peer.peerId) as
    | { remote_node_id: string | null; remote_public_key: string | null }
    | undefined;
  const keyBound = peerIdentity?.remote_node_id != null || peerIdentity?.remote_public_key != null;
  const tally: Tally = { pulled: 0, conflicts: 0, purged: 0, deferred: 0, rejected: 0 };
  const count = (result: ApplyResult) => {
    if (result.outcome === "fast-forward") tally.pulled++;
    else if (result.outcome === "conflict-resolved") tally.conflicts++;
    else if (result.outcome === "purge-stripped") tally.purged++;
    else if (result.outcome === "deferred") tally.deferred++;
  };
  /** Apply one item; on a refusal, record it and return false. Environmental failures propagate. */
  const attempt = (incoming: IncomingItem): boolean => {
    let event: WireEvent | undefined;
    try {
      event = decodeIncoming(incoming, sealedKeys);
      count(applyDecoded(db, peer.name, keyBound, incoming, event, sealedStore));
      // A purge applied inside a sealed pool can't reach this table in the main database itself.
      if (event.op === "purge") db.prepare("DELETE FROM sync_rejections WHERE entry_id = ?").run(event.entryId);
      return true;
    } catch (err) {
      if (isEnvironmentalFailure(err)) throw err;
      recordRejection(db, peer.name, incoming, event, err, sealedStore);
      tally.rejected++;
      return false;
    }
  };

  const retries = db.prepare(
    "SELECT event_id, raw FROM sync_rejections WHERE peer_node = ? AND raw IS NOT NULL ORDER BY origin_node, origin_seq, event_id",
  ).all(peer.name) as { event_id: string; raw: string }[];
  for (const row of retries) {
    if (attempt(JSON.parse(row.raw) as IncomingItem)) {
      db.prepare("DELETE FROM sync_rejections WHERE peer_node = ? AND event_id = ?").run(peer.name, row.event_id);
    }
  }

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

    for (const incoming of body.events) attempt(incoming);
    storeThrough(db, peer.name, body.through);
    Object.assign(vector, body.through);
    lastThrough = body.through;
    more = body.more;
  }
  // Spec 7.4's tentative-claim check (src/store/claim.ts) reads this: a completed pull counts as
  // "successful" whether or not it carried any new events, so an idle-but-reachable peer still
  // keeps claims on this node out of tentative state.
  db.prepare("UPDATE peers SET last_synced_at = ? WHERE peer_id = ?").run(nowIso(), peer.peerId);
  return { ...tally, through: lastThrough };
}

function isSealedItem(incoming: IncomingItem): incoming is EncryptedWireEvent {
  return typeof incoming === "object" && incoming !== null && "sealed" in incoming && incoming.sealed === true;
}

/** The wire event inside an item, decrypting a sealed envelope. */
function decodeIncoming(incoming: IncomingItem, sealedKeys?: SealedKeyProvider): WireEvent {
  if (!isSealedItem(incoming)) return incoming;
  const plain = decryptSealed(incoming.envelope, sealedKeys?.get(incoming.pool_id) ?? Buffer.alloc(0), incoming.event_id);
  return JSON.parse(plain.toString("utf8")) as WireEvent;
}

function applyDecoded(
  db: Database.Database,
  peerName: string,
  keyBound: boolean,
  incoming: IncomingItem,
  event: WireEvent,
  sealedStore?: SealedPoolStore,
): ApplyResult {
  const apply = (target: Database.Database) => {
    assertPeerMayDeliver(target, peerName, keyBound, event);
    return applyEvent(target, event);
  };
  if (!isSealedItem(incoming)) return apply(db);
  if (!sealedStore) throw new Error(`sealed event ${incoming.event_id} has no attached-store router`);
  return sealedStore.withPool(incoming.pool_id, apply);
}

/**
 * Upsert one refused item into `sync_rejections` (#74). The item is kept exactly as received (a
 * sealed item stays its ciphertext envelope) so every later pull can retry it: failures that heal
 * on their own (an origin key pinned later, a sealed pool key or store that arrives later) must not
 * lose the event once the watermark has moved past it. Not kept when its entry is already purged
 * here, so a stored payload never outlives a purge.
 */
function recordRejection(
  db: Database.Database,
  peerName: string,
  incoming: IncomingItem,
  event: WireEvent | undefined,
  err: unknown,
  sealedStore?: SealedPoolStore,
): void {
  // The item is untrusted and may be malformed anywhere, so every field is type-checked before use.
  const raw = JSON.stringify(incoming) ?? "null";
  const field = (value: unknown, key: string): unknown => (value != null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const seq = field(event, "originSeq");
  const entryId = text(field(event, "entryId"));
  const eventId = text(field(event, "eventId")) ?? text(field(incoming, "event_id")) ?? text(field(incoming, "eventId")) ??
    `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  // A sealed entry lives (and is purged) in its pool's own database, not the main one.
  const isPurged = (target: Database.Database) =>
    (target.prepare("SELECT purged_at FROM entries WHERE entry_id = ?").get(entryId) as { purged_at: string | null } | undefined)?.purged_at != null;
  const purgedInPool = (poolId: string): boolean => {
    try {
      return sealedStore!.withPool(poolId, isPurged);
    } catch (poolErr) {
      if (isEnvironmentalFailure(poolErr)) throw poolErr;
      return false; // the pool can't be opened yet (the likely reason this item failed): keep its ciphertext for the retry
    }
  };
  const purged = entryId != null &&
    (isPurged(db) || (isSealedItem(incoming) && sealedStore !== undefined && purgedInPool(incoming.pool_id)));
  // Peer-controlled text ends up in terminal output (ctxd doctor): sanitize it like any stored text, on one line.
  const reason = redactSecrets(sanitize(err instanceof Error ? err.message : String(err))).replace(/[\t\n]/g, " ").slice(0, 500);
  const now = nowIso();
  db.prepare(
    `INSERT INTO sync_rejections (peer_node, event_id, origin_node, origin_seq, entry_id, raw, reason, first_rejected_at, last_rejected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (peer_node, event_id) DO UPDATE SET reason = excluded.reason, attempts = attempts + 1,
       last_rejected_at = excluded.last_rejected_at, raw = excluded.raw,
       origin_node = COALESCE(excluded.origin_node, origin_node), origin_seq = COALESCE(excluded.origin_seq, origin_seq),
       entry_id = COALESCE(excluded.entry_id, entry_id)`,
  ).run(peerName, eventId, text(field(event, "originNode")), Number.isInteger(seq) ? seq : null, entryId, purged ? null : raw, reason, now, now);
}

/**
 * Peer binding (LLD replication 7.7): a peer paired with `--node-id` and `--public-key` is an
 * authenticated identity, so everything it delivers must be signed; `applyEvent` then verifies the
 * signature against the origin's pinned key, which also authorizes relaying signed events from
 * other pinned origins. An unsigned event from such a peer is refused whatever origin it claims,
 * since nothing ties it to that origin (a forged `originNode`, an unsigned acl or purge event). An
 * event already stored here is let through to `applyEvent`'s dedup, so this node's own older
 * unsigned events echoed back by the peer never stall the pull. A peer with neither a bound node
 * id nor a bound key is the legacy unauthenticated mode and is not checked here.
 */
export function assertPeerMayDeliver(db: Database.Database, peerName: string, keyBound: boolean, event: WireEvent): void {
  if (!keyBound || event.signature != null) return;
  if (db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(event.eventId)) return;
  throw new Error(`pull from ${peerName}: refused unsigned event ${event.eventId} claiming origin ${event.originNode}; a key-bound peer may only deliver signed events`);
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

/**
 * The served-side mirror of `storeThrough` (W3): POST /v1/pull's handler (`src/server/sync.ts`)
 * calls this after `servePull` so `peer_watermarks` records how far this node has served each
 * peer, per origin -- otherwise serving is stateless and `ctxd doctor`/`ctxd status` have no way
 * to answer "how far behind is this peer." Takes the max against any existing watermark, same as
 * `through_seq` itself only ever advances within one pull.
 */
export function recordServedThrough(db: Database.Database, peerId: string, through: Record<string, number>): void {
  const stmt = db.prepare(
    `INSERT INTO peer_watermarks (peer_id, origin_node, through_seq, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (peer_id, origin_node) DO UPDATE SET through_seq = MAX(through_seq, excluded.through_seq), updated_at = excluded.updated_at`,
  );
  const now = nowIso();
  db.transaction(() => {
    for (const [originNode, seq] of Object.entries(through)) stmt.run(peerId, originNode, seq, now);
  })();
}
