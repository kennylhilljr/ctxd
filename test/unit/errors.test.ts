import { describe, expect, it } from "vitest";
import { CtxdError, ERROR_CODES, ERROR_GUIDANCE, enumError } from "../../src/core/errors.js";

describe("error envelope (SPEC v6 8.5)", () => {
  it("gives every code a hint and a retryable flag", () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_GUIDANCE[code].hint.length).toBeGreaterThan(10);
      expect(typeof ERROR_GUIDANCE[code].retryable).toBe("boolean");
    }
  });

  it("serializes code, message, field, hint, retryable and details", () => {
    const e = new CtxdError("REV_CONFLICT", "Entry changed since you read it", { current_rev: "4-01JAB" }, "expected_rev");
    expect(e.toJSON()).toEqual({
      error: {
        code: "REV_CONFLICT",
        message: "Entry changed since you read it",
        field: "expected_rev",
        hint: ERROR_GUIDANCE.REV_CONFLICT.hint,
        retryable: true,
        details: { current_rev: "4-01JAB" },
      },
    });
  });

  it("lists allowed values for enum errors and never echoes long input", () => {
    const env = enumError("kind", "x".repeat(500), ["decision", "lesson"]).toJSON();
    expect(env.error.hint).toBe("Use one of: decision, lesson.");
    expect(String(env.error.details.got).length).toBe(40);
    expect(env.error.field).toBe("kind");
  });
});
