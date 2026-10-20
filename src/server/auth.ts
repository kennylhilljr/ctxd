import type Database from "better-sqlite3";
import { sha256Hex } from "../core/hash.js";
import type { Vendor } from "../core/kinds.js";

export interface AuthResult {
  clientId: string;
  clientName: string;
  vendor: Vendor;
  /** [] means _me-only: either no persona token matched, or this client authenticated with its plain base token. */
  assumedPools: string[];
}

/**
 * Resolve a bearer token to a client and its assumed pools (SPEC v6 sections 8.4, 10.5).
 * Tries a persona token first (gives client + its sorted pool ids), then falls back to the
 * client's own plain token (SPEC v6 section 3), which carries no persona: assumedPools is [].
 */
export function resolveBearerAuth(db: Database.Database, token: string): AuthResult | null {
  const hash = sha256Hex(token);

  const persona = db.prepare("SELECT client_id, pools FROM persona_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(hash) as
    | { client_id: string; pools: string }
    | undefined;
  if (persona) {
    const client = clientById(db, persona.client_id);
    return client ? { ...client, assumedPools: JSON.parse(persona.pools) as string[] } : null;
  }

  const row = db.prepare("SELECT client_id, name, vendor, revoked_at FROM clients WHERE token_hash = ?").get(hash) as
    | { client_id: string; name: string; vendor: Vendor; revoked_at: string | null }
    | undefined;
  if (!row || row.revoked_at !== null) return null;
  return { clientId: row.client_id, clientName: row.name, vendor: row.vendor, assumedPools: [] };
}

function clientById(db: Database.Database, clientId: string): { clientId: string; clientName: string; vendor: Vendor } | null {
  const row = db.prepare("SELECT name, vendor, revoked_at FROM clients WHERE client_id = ?").get(clientId) as
    | { name: string; vendor: Vendor; revoked_at: string | null }
    | undefined;
  if (!row || row.revoked_at !== null) return null;
  return { clientId, clientName: row.name, vendor: row.vendor };
}

export interface PeerAuthResult {
  peerId: string;
  peerName: string;
  /** The peer's own role, for the 7.2 replication filter when it pulls from us. */
  peerRole: "home" | "roaming";
  remoteNodeId: string | null;
  remotePublicKey: string | null;
}

/** Resolve a bearer token on the sync listener to the peer that holds it (Spec 7.1). */
export function resolvePeerAuth(db: Database.Database, token: string): PeerAuthResult | null {
  const hash = sha256Hex(token);
  const row = db.prepare("SELECT peer_id, name, role, revoked_at, remote_node_id, remote_public_key FROM peers WHERE incoming_token_hash = ?").get(hash) as
    | { peer_id: string; name: string; role: "home" | "roaming"; revoked_at: string | null; remote_node_id: string | null; remote_public_key: string | null }
    | undefined;
  if (!row || row.revoked_at !== null) return null;
  return { peerId: row.peer_id, peerName: row.name, peerRole: row.role, remoteNodeId: row.remote_node_id, remotePublicKey: row.remote_public_key };
}
