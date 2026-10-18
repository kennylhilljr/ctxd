/** Error codes returned by MCP tools (SPEC section 8.2). */
export const ERROR_CODES = [
  "UNAUTHORIZED",
  "SCOPE_FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "REV_CONFLICT",
  "IMMUTABLE_KIND",
  "REDACTED_SECRET",
  "CLAIM_HELD",
  "CLAIM_STALE",
  "CLAIM_OVERLAP",
  "BUDGET_EXCEEDED",
  "IDEMPOTENCY_MISMATCH",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class CtxdError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CtxdError";
  }

  toJSON(): { error: { code: ErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
