import { createHash } from "node:crypto";

/** SHA-256 of `input`, hex-encoded. Used for token hashing throughout (SPEC v6 section 10.1). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
