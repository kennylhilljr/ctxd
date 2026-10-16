import type { z } from "zod";
import type { contextWriteInput } from "../tools/schemas.js";
import { notImplemented } from "../core/todo.js";

export interface WriteResult {
  id: string;
  rev: string;
  status: string;
}

/**
 * The single write path (SPEC section 6): auth, idempotency, validation, redaction,
 * optimistic concurrency, review policy, append event, materialize. Milestone M1.
 */
export function writeEntry(_clientId: string, _input: z.infer<typeof contextWriteInput>): WriteResult {
  return notImplemented("writeEntry", "M1");
}
