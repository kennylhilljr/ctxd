/**
 * W2: the authenticated sealed pool key transfer protocol. `ctxd pool enroll <pool> <node>`'s own
 * stub (`SealedPoolStore.enroll`) used to throw unconditionally; this is what it now drives.
 * Design in docs/spec/SPEC-v10-draft.md's "W2: sealed pool key transfer" section.
 *
 * Four steps, each a small pure-ish function against the main database, deliberately with no
 * MCP tool anywhere near them: every one of these is reachable only from `ctxd pool`'s own CLI
 * commands (src/cli/pool.ts) or the sync listener's key-transfer endpoints (src/server/sync.ts),
 * which is what makes `approveKeyTransfer` "the owner's explicit approval" by construction,
 * the same way `ctxd pool seal`/`ctxd backup` are owner-only by never being exposed as a tool,
 * rather than by an extra vendor check the way `resolveEntry` needs one (it IS reachable from a
 * shared WriteContext that could be a non-human client; this code path never is).
 *
 *   1. requestKeyTransfer (source side): a trusted, un-revoked peer presents a signed prekey and
 *      asks for a pool's key. Creates a `pending` row with a short expiry. Never approves itself.
 *   2. approveKeyTransfer (source side, owner-only by construction): wraps the real pool key with
 *      the ECDH-derived transfer key, and returns a confirmation code derived the same way, never
 *      transmitted alongside the wrapped key.
 *   3. fetchWrappedKey (source side): returns the wrapped key only once, only once approved --
 *      the one-time-use rule that is this design's replay protection.
 *   4. completeKeyTransfer (recipient side): unwraps and installs the key via the recipient's own
 *      SealedKeyProvider.store, and returns the same confirmation code to compare against step 2's.
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import type Database from "better-sqlite3";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { CtxdError } from "../core/errors.js";
import { decryptSealed, encryptSealed, type CiphertextEnvelope } from "./crypto.js";
import type { SealedKeyProvider } from "./key-provider.js";
import { type EncryptionKeyPair, deriveConfirmationCode, deriveTransferWrapKey, pinEncryptionPrekey, signEncryptionPrekey, verifyEncryptionPrekey } from "./encryptionKeys.js";

const TRANSFER_TTL_MINUTES = 10;

export interface SignedPrekey {
  nodeId: string;
  publicKey: string;
  signature: string;
}

/** The Ed25519 identity a peer enrollment already pinned for this node (M6), the trust anchor for its presented encryption prekey. Also the revocation check: a revoked peer has no row here. */
function trustedPeerSigningKey(db: Database.Database, nodeId: string): KeyObject {
  const row = db.prepare("SELECT remote_public_key FROM peers WHERE remote_node_id = ? AND revoked_at IS NULL AND remote_public_key IS NOT NULL").get(nodeId) as
    | { remote_public_key: string }
    | undefined;
  if (!row) throw new CtxdError("UNAUTHORIZED", `No trusted, un-revoked peer identity for node ${nodeId}`);
  return createPublicKey({ key: Buffer.from(row.remote_public_key, "base64"), type: "spki", format: "der" });
}

export interface TransferRequestResult {
  transferId: string;
  sourcePrekey: SignedPrekey;
}

/** Source side: verifies the requester's presented prekey against its already-pinned identity, refusing a revoked or unknown node outright, then records a pending transfer. */
export function requestKeyTransfer(
  db: Database.Database,
  poolId: string,
  requesterPrekey: SignedPrekey,
  sourceNodeId: string,
  sourceSigningPrivateKey: KeyObject,
  sourceEncKeyPair: EncryptionKeyPair,
): TransferRequestResult {
  const requesterSigningKey = trustedPeerSigningKey(db, requesterPrekey.nodeId);
  verifyEncryptionPrekey(requesterPrekey.nodeId, requesterPrekey.publicKey, requesterPrekey.signature, requesterSigningKey);
  pinEncryptionPrekey(db, requesterPrekey.nodeId, requesterPrekey.publicKey, requesterPrekey.signature);

  const pool = db.prepare("SELECT storage FROM pools WHERE pool_id = ?").get(poolId) as { storage: string } | undefined;
  if (!pool || pool.storage !== "sealed") throw new CtxdError("VALIDATION", `${poolId} is not a sealed pool`, {}, "poolId");

  const transferId = newId();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + TRANSFER_TTL_MINUTES * 60_000).toISOString();
  db.prepare(
    "INSERT INTO sealed_key_transfers (transfer_id, pool_id, requester_node_id, source_node_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
  ).run(transferId, poolId, requesterPrekey.nodeId, sourceNodeId, now, expiresAt);

  const sourcePrekey = signEncryptionPrekey(sourceNodeId, sourceEncKeyPair, sourceSigningPrivateKey);
  return { transferId, sourcePrekey: { nodeId: sourceNodeId, ...sourcePrekey } };
}

interface PendingTransferRow {
  pool_id: string;
  requester_node_id: string;
  status: string;
  expires_at: string;
}

function loadTransfer(db: Database.Database, transferId: string): PendingTransferRow {
  const row = db.prepare("SELECT pool_id, requester_node_id, status, expires_at FROM sealed_key_transfers WHERE transfer_id = ?").get(transferId) as PendingTransferRow | undefined;
  if (!row) throw new CtxdError("NOT_FOUND", `No such key transfer: ${transferId}`, {}, "transferId");
  return row;
}

/** Source side, owner-only: wraps the real pool key for the requester and records the confirmation code's inputs. Refuses an unknown, already-decided or expired transfer. */
export function approveKeyTransfer(db: Database.Database, transferId: string, sourceEncKeyPair: EncryptionKeyPair, poolKey: Buffer): { confirmationCode: string } {
  const transfer = loadTransfer(db, transferId);
  if (transfer.status !== "pending") throw new CtxdError("VALIDATION", `Key transfer ${transferId} is not pending (status: ${transfer.status})`, {}, "transferId");
  if (Date.parse(transfer.expires_at) < Date.now()) {
    db.prepare("UPDATE sealed_key_transfers SET status = 'refused' WHERE transfer_id = ?").run(transferId);
    throw new CtxdError("VALIDATION", `Key transfer ${transferId} expired`, {}, "transferId");
  }

  const requesterPrekey = db.prepare("SELECT public_key FROM node_encryption_keys WHERE node_id = ?").get(transfer.requester_node_id) as { public_key: string } | undefined;
  if (!requesterPrekey) throw new CtxdError("UNAUTHORIZED", `No pinned encryption prekey for node ${transfer.requester_node_id}`);

  const wrapKey = deriveTransferWrapKey(sourceEncKeyPair.privateKey, requesterPrekey.public_key);
  const wrapped = encryptSealed(poolKey, wrapKey, transferId);
  db.prepare("UPDATE sealed_key_transfers SET status = 'approved', wrapped_key = ?, approved_at = ? WHERE transfer_id = ?").run(JSON.stringify(wrapped), nowIso(), transferId);

  return { confirmationCode: deriveConfirmationCode(sourceEncKeyPair.privateKey, requesterPrekey.public_key) };
}

/** Source side: the one-time-use fetch. Refuses before approval and on any second call (replay protection), each with its own specific error. */
export function fetchWrappedKey(db: Database.Database, transferId: string): CiphertextEnvelope {
  return db.transaction(() => {
    const row = db.prepare("SELECT status, wrapped_key, fetched_at FROM sealed_key_transfers WHERE transfer_id = ?").get(transferId) as
      | { status: string; wrapped_key: string | null; fetched_at: string | null }
      | undefined;
    if (!row) throw new CtxdError("NOT_FOUND", `No such key transfer: ${transferId}`, {}, "transferId");
    if (row.fetched_at !== null) throw new CtxdError("VALIDATION", `Key transfer ${transferId} was already fetched`, {}, "transferId");
    if (row.status !== "approved" || !row.wrapped_key) throw new CtxdError("NOT_ALLOWED", `Key transfer ${transferId} has not been approved yet`, {}, "transferId");
    db.prepare("UPDATE sealed_key_transfers SET status = 'fetched', fetched_at = ? WHERE transfer_id = ?").run(nowIso(), transferId);
    return JSON.parse(row.wrapped_key) as CiphertextEnvelope;
  })();
}

/** Recipient side: unwraps the fetched key and installs it via the recipient's own SealedKeyProvider, returning the confirmation code to compare against what the owner saw on the source. */
export function completeKeyTransfer(
  transferId: string,
  requesterEncKeyPair: EncryptionKeyPair,
  sourcePrekey: SignedPrekey,
  wrappedKey: CiphertextEnvelope,
  poolId: string,
  keys: SealedKeyProvider,
): { confirmationCode: string } {
  const wrapKey = deriveTransferWrapKey(requesterEncKeyPair.privateKey, sourcePrekey.publicKey);
  const poolKey = decryptSealed(wrappedKey, wrapKey, transferId);
  keys.store(poolId, poolKey);
  return { confirmationCode: deriveConfirmationCode(requesterEncKeyPair.privateKey, sourcePrekey.publicKey) };
}
