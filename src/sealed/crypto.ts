import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface CiphertextEnvelope { nonce: string; ciphertext: string; tag: string }

function rotate(value: number, bits: number): number { return ((value << bits) | (value >>> (32 - bits))) >>> 0; }
function quarter(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = rotate(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotate(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = rotate(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotate(s[b]! ^ s[c]!, 7);
}

function hchacha20(key: Buffer, nonce: Buffer): Buffer {
  const constants = Buffer.from("expand 32-byte k");
  const input = Buffer.concat([constants, key, nonce]);
  const state = new Uint32Array(16);
  for (let i = 0; i < 16; i++) state[i] = input.readUInt32LE(i * 4);
  for (let i = 0; i < 10; i++) {
    quarter(state, 0, 4, 8, 12); quarter(state, 1, 5, 9, 13); quarter(state, 2, 6, 10, 14); quarter(state, 3, 7, 11, 15);
    quarter(state, 0, 5, 10, 15); quarter(state, 1, 6, 11, 12); quarter(state, 2, 7, 8, 13); quarter(state, 3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [state[0]!, state[1]!, state[2]!, state[3]!, state[12]!, state[13]!, state[14]!, state[15]!].forEach((word, i) => out.writeUInt32LE(word, i * 4));
  return out;
}

export function encryptSealed(plaintext: Buffer, key: Buffer, associatedData: string): CiphertextEnvelope {
  if (key.length !== 32) throw new Error("sealed key must be 32 bytes");
  const nonce = randomBytes(24);
  const subkey = hchacha20(key, nonce.subarray(0, 16));
  const nonce12 = Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]);
  const cipher = createCipheriv("chacha20-poly1305", subkey, nonce12, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(associatedData), { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptSealed(envelope: CiphertextEnvelope, key: Buffer, associatedData: string): Buffer {
  const nonce = Buffer.from(envelope.nonce, "base64");
  if (key.length !== 32 || nonce.length !== 24) throw new Error("invalid sealed key or nonce");
  const subkey = hchacha20(key, nonce.subarray(0, 16));
  const decipher = createDecipheriv("chacha20-poly1305", subkey, Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]), { authTagLength: 16 });
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  decipher.setAAD(Buffer.from(associatedData), { plaintextLength: ciphertext.length });
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
