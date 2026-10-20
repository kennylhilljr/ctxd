import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { CtxdError } from "../../src/core/errors.js";
import {
  FileEncryptionKeyProvider,
  deriveConfirmationCode,
  deriveTransferWrapKey,
  pinEncryptionPrekey,
  signEncryptionPrekey,
  verifyEncryptionPrekey,
} from "../../src/sealed/encryptionKeys.js";

/** W2: the signed X25519 prekey primitives key transfer is built on, tested in isolation from the transfer protocol itself. */

describe("FileEncryptionKeyProvider", () => {
  it("generates a keypair once and reuses it across calls, even with a fresh provider instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxd-enc-keys-"));
    const dbPath = join(dir, "ctxd.db");
    const nodeId = newId();
    const first = new FileEncryptionKeyProvider(dbPath).keyPair(nodeId);
    const second = new FileEncryptionKeyProvider(dbPath).keyPair(nodeId);
    expect(first.publicKey.export({ type: "spki", format: "der" })).toEqual(second.publicKey.export({ type: "spki", format: "der" }));
  });

  it("keeps separate in-memory keys for :memory: databases, keyed by nodeId", () => {
    const a = new FileEncryptionKeyProvider(":memory:").keyPair("node-a");
    const b = new FileEncryptionKeyProvider(":memory:").keyPair("node-b");
    expect(a.publicKey.export({ type: "spki", format: "der" })).not.toEqual(b.publicKey.export({ type: "spki", format: "der" }));
  });
});

describe("signEncryptionPrekey / verifyEncryptionPrekey", () => {
  it("verifies a correctly signed prekey", () => {
    const nodeId = newId();
    const signingKeys = generateKeyPairSync("ed25519");
    const encKeys = new FileEncryptionKeyProvider(":memory:").keyPair(nodeId);
    const presented = signEncryptionPrekey(nodeId, encKeys, signingKeys.privateKey);
    expect(() => verifyEncryptionPrekey(nodeId, presented.publicKey, presented.signature, signingKeys.publicKey)).not.toThrow();
  });

  it("rejects a prekey signed by a different identity (MITM substitution)", () => {
    const nodeId = newId();
    const realSigningKeys = generateKeyPairSync("ed25519");
    const attackerSigningKeys = generateKeyPairSync("ed25519");
    const encKeys = new FileEncryptionKeyProvider(":memory:").keyPair(nodeId);
    const presented = signEncryptionPrekey(nodeId, encKeys, attackerSigningKeys.privateKey);
    expect(() => verifyEncryptionPrekey(nodeId, presented.publicKey, presented.signature, realSigningKeys.publicKey)).toThrow(CtxdError);
  });

  it("rejects a prekey whose signature was bound to a different node id", () => {
    const signingKeys = generateKeyPairSync("ed25519");
    const encKeys = new FileEncryptionKeyProvider(":memory:").keyPair("node-a");
    const presented = signEncryptionPrekey("node-a", encKeys, signingKeys.privateKey);
    expect(() => verifyEncryptionPrekey("node-b", presented.publicKey, presented.signature, signingKeys.publicKey)).toThrow(CtxdError);
  });
});

describe("pinEncryptionPrekey", () => {
  function freshDb() {
    return openDatabase(join(mkdtempSync(join(tmpdir(), "ctxd-enc-pin-")), "ctxd.db"), { create: true });
  }

  it("pins a prekey the first time it is seen", () => {
    const db = freshDb();
    pinEncryptionPrekey(db, "node-a", "pub1", "sig1");
    const row = db.prepare("SELECT public_key FROM node_encryption_keys WHERE node_id = 'node-a'").get() as { public_key: string };
    expect(row.public_key).toBe("pub1");
  });

  it("is idempotent for the same key", () => {
    const db = freshDb();
    pinEncryptionPrekey(db, "node-a", "pub1", "sig1");
    expect(() => pinEncryptionPrekey(db, "node-a", "pub1", "sig1")).not.toThrow();
  });

  it("refuses a different key for an already-pinned node", () => {
    const db = freshDb();
    pinEncryptionPrekey(db, "node-a", "pub1", "sig1");
    expect(() => pinEncryptionPrekey(db, "node-a", "pub2", "sig2")).toThrow(CtxdError);
  });
});

describe("deriveTransferWrapKey / deriveConfirmationCode", () => {
  it("both sides derive the same wrap key and the same confirmation code from one ECDH exchange", () => {
    const a = new FileEncryptionKeyProvider(":memory:").keyPair("node-a");
    const b = new FileEncryptionKeyProvider(":memory:").keyPair("node-b");
    const aPub = a.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const bPub = b.publicKey.export({ type: "spki", format: "der" }).toString("base64");

    expect(deriveTransferWrapKey(a.privateKey, bPub)).toEqual(deriveTransferWrapKey(b.privateKey, aPub));
    expect(deriveConfirmationCode(a.privateKey, bPub)).toBe(deriveConfirmationCode(b.privateKey, aPub));
  });

  it("produces a 6-digit, zero-padded confirmation code", () => {
    const a = new FileEncryptionKeyProvider(":memory:").keyPair("node-a");
    const b = new FileEncryptionKeyProvider(":memory:").keyPair("node-b");
    const bPub = b.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(deriveConfirmationCode(a.privateKey, bPub)).toMatch(/^\d{6}$/);
  });

  it("derives a different wrap key and code for a different peer pairing", () => {
    const a = new FileEncryptionKeyProvider(":memory:").keyPair("node-a");
    const b = new FileEncryptionKeyProvider(":memory:").keyPair("node-b");
    const c = new FileEncryptionKeyProvider(":memory:").keyPair("node-c");
    const bPub = b.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const cPub = c.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(deriveTransferWrapKey(a.privateKey, bPub)).not.toEqual(deriveTransferWrapKey(a.privateKey, cPub));
  });
});
