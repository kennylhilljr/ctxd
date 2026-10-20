/**
 * W2: each node's long-lived X25519 encryption prekey, separate from its Ed25519 event-signing
 * identity (src/security/event-signatures.ts), but bound to it: the prekey is signed with the
 * node's own Ed25519 private key, so a peer that already trusts that node's Ed25519 identity
 * (`peers.remote_public_key`, pinned at enrollment, M6) can verify the prekey actually belongs to
 * it before ever using it for a sealed pool key transfer (src/sealed/keyTransfer.ts).
 *
 * The private key lives in a PEM file beside the node's Ed25519 identity file, the same pattern
 * `FileEventKeyProvider` already uses, never in the SQLite database. `node_encryption_keys`
 * holds only public material: this node's own public key (for convenient lookup) and, once
 * verified, each peer's pinned prekey -- the same dual local/remote role `node_keys` already
 * plays for Ed25519 identities.
 */
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { CtxdError } from "../core/errors.js";

export interface EncryptionKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface EncryptionKeyProvider {
  keyPair(nodeId: string): EncryptionKeyPair;
}

const memoryKeys = new Map<string, EncryptionKeyPair>();

export class FileEncryptionKeyProvider implements EncryptionKeyProvider {
  constructor(private readonly databasePath: string) {}

  keyPair(nodeId: string): EncryptionKeyPair {
    if (this.databasePath === "" || this.databasePath === ":memory:") {
      const existing = memoryKeys.get(nodeId);
      if (existing) return existing;
      const created = generateKeyPairSync("x25519");
      memoryKeys.set(nodeId, created);
      return created;
    }
    const path = join(dirname(this.databasePath), "node.x25519.pem");
    if (existsSync(path)) {
      const privateKey = createPrivateKey(readFileSync(path));
      return { privateKey, publicKey: createPublicKey(privateKey) };
    }
    const created = generateKeyPairSync("x25519");
    writeFileSync(path, created.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    return created;
  }
}

function publicKeyDer(key: KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" });
}

/** Signs `nodeId || encPublicKey` with the node's own Ed25519 identity key, binding the prekey to it. */
export function signEncryptionPrekey(nodeId: string, encKeyPair: EncryptionKeyPair, signingPrivateKey: KeyObject): { publicKey: string; signature: string } {
  const publicKey = publicKeyDer(encKeyPair.publicKey).toString("base64");
  const signature = sign(null, Buffer.from(`${nodeId}:${publicKey}`), signingPrivateKey).toString("base64");
  return { publicKey, signature };
}

/** Verifies a presented prekey against the presenting node's already-trusted Ed25519 identity. Throws, never returns false, so a caller cannot forget to check the result. */
export function verifyEncryptionPrekey(nodeId: string, publicKey: string, signature: string, trustedSigningPublicKey: KeyObject): void {
  const ok = verify(null, Buffer.from(`${nodeId}:${publicKey}`), trustedSigningPublicKey, Buffer.from(signature, "base64"));
  if (!ok) throw new CtxdError("UNAUTHORIZED", `Invalid encryption prekey signature for node ${nodeId}`);
}

/** Pins a peer's verified prekey the first time it is seen; refuses a later call with a different key for the same node, mirroring pinPublicKey's "public key changed" guard. */
export function pinEncryptionPrekey(db: Database.Database, nodeId: string, publicKey: string, signature: string): void {
  const existing = db.prepare("SELECT public_key FROM node_encryption_keys WHERE node_id = ?").get(nodeId) as { public_key: string } | undefined;
  if (existing) {
    if (existing.public_key !== publicKey) throw new CtxdError("UNAUTHORIZED", `Encryption prekey changed for node ${nodeId}`);
    return;
  }
  db.prepare("INSERT INTO node_encryption_keys (node_id, public_key, signature, created_at) VALUES (?, ?, ?, ?)").run(nodeId, publicKey, signature, new Date().toISOString());
}

function importPublicKey(base64Der: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64Der, "base64"), type: "spki", format: "der" });
}

/** The ECDH shared secret between this node's private key and a peer's presented public key, HKDF-derived into a purpose-specific 32-byte key. Same shared secret either direction, by construction. */
function derive(myPrivateKey: KeyObject, theirPublicKeyBase64: string, info: string, length = 32): Buffer {
  const shared = diffieHellman({ privateKey: myPrivateKey, publicKey: importPublicKey(theirPublicKeyBase64) });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(info), length));
}

/** The symmetric key used to wrap/unwrap the transferred pool key (encryptSealed/decryptSealed). */
export function deriveTransferWrapKey(myPrivateKey: KeyObject, theirPublicKeyBase64: string): Buffer {
  return derive(myPrivateKey, theirPublicKeyBase64, "ctxd-sealed-key-transfer-wrap");
}

/** A 6-digit code both sides compute independently from the same shared secret, never transmitted, for the owner to visually compare on both screens. */
export function deriveConfirmationCode(myPrivateKey: KeyObject, theirPublicKeyBase64: string): string {
  const bytes = derive(myPrivateKey, theirPublicKeyBase64, "ctxd-sealed-key-transfer-code", 4);
  const code = bytes.readUInt32BE(0) % 1_000_000;
  return code.toString().padStart(6, "0");
}
