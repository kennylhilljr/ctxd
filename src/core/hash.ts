import { createHash, randomBytes } from "node:crypto";

/** SHA-256 of `input`, hex-encoded. Used for token hashing throughout (SPEC v6 section 10.1). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A fresh bearer token (raw, to hand to whoever holds it) and its SHA-256 hash (to store). */
export function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: sha256Hex(raw) };
}
