/** Error codes returned by MCP tools (SPEC v6 sections 8.2 and 8.5). */
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
  "NOT_ALLOWED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Whether a retry can succeed, and what the agent should do next (SPEC v6 8.5). */
export const ERROR_GUIDANCE: Readonly<Record<ErrorCode, { retryable: boolean; hint: string }>> = {
  UNAUTHORIZED: { retryable: false, hint: "Your ctxd token is missing or revoked; tell the user." },
  SCOPE_FORBIDDEN: { retryable: false, hint: "This scope is outside your persona; tell the user if you need it." },
  NOT_FOUND: { retryable: false, hint: "Check the reference or path, or search with context_search." },
  VALIDATION: { retryable: true, hint: "Fix the named field and retry." },
  REV_CONFLICT: {
    retryable: true,
    hint: "Re-read the entry with context_get and retry with its current rev, or ask the user.",
  },
  IMMUTABLE_KIND: { retryable: true, hint: "Write a new entry instead (with supersedes for decisions)." },
  REDACTED_SECRET: {
    retryable: true,
    hint: "Remove the secret the named detector found and retry; refer to credentials by name.",
  },
  CLAIM_HELD: { retryable: false, hint: "Another agent holds this task; pick another or ask the user." },
  CLAIM_STALE: {
    retryable: true,
    hint: "Check the returned facts; if the work is not done, retry with take_over: true.",
  },
  CLAIM_OVERLAP: { retryable: false, hint: "Tell the user about the overlap before proceeding." },
  BUDGET_EXCEEDED: { retryable: true, hint: "Lower max_tokens or fetch fewer ids." },
  IDEMPOTENCY_MISMATCH: { retryable: true, hint: "Use a new request_id for a different write." },
  NOT_ALLOWED: { retryable: false, hint: "This operation needs the user." },
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
    hint: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

export class CtxdError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    /** The input field at fault, when there is one. */
    readonly field?: string,
    /** Overrides the code's default hint, e.g. to list allowed enum values. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CtxdError";
  }

  toJSON(): ErrorEnvelope {
    const g = ERROR_GUIDANCE[this.code];
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field !== undefined ? { field: this.field } : {}),
        hint: this.hint ?? g.hint,
        retryable: g.retryable,
        details: this.details,
      },
    };
  }
}

/** A VALIDATION error for an enum field, naming the allowed values in the hint. */
export function enumError(field: string, got: unknown, allowed: readonly string[]): CtxdError {
  return new CtxdError(
    "VALIDATION",
    `Invalid value for ${field}`,
    { got: typeof got === "string" ? got.slice(0, 40) : typeof got },
    field,
    `Use one of: ${allowed.join(", ")}.`,
  );
}
