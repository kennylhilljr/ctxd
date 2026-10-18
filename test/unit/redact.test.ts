import { describe, expect, it } from "vitest";
import {
  detectSecrets,
  redactSecrets,
  sanitize,
  sanitizeAgentText,
  sanitizeCapture,
  stripInvisible,
  stripPrivate,
} from "../../src/security/redact.js";

const GH = "ghp_" + "a".repeat(36);

describe("sanitization pipeline (SPEC 6.1)", () => {
  it("strips private blocks", () => {
    expect(stripPrivate("keep <private>hide me</private> this")).toBe("keep [private content removed] this");
  });

  it("strips invisible and bidirectional characters but keeps newlines and tabs", () => {
    expect(stripInvisible("a​b‮c⁦d﻿e\u0007f\n\tg")).toBe("abcdef\n\tg");
  });

  it("catches a secret split by a zero-width character", () => {
    const split = GH.slice(0, 10) + "​" + GH.slice(10);
    expect(detectSecrets(split)).toEqual([]);
    expect(sanitizeAgentText(split)).toEqual({ ok: false, detectors: ["github-token"] });
  });

  it("rejects agent writes with secrets and passes clean text", () => {
    expect(sanitizeAgentText("Use an event log, not cr-sqlite.")).toEqual({
      ok: true,
      text: "Use an event log, not cr-sqlite.",
    });
    expect(sanitizeAgentText(`token here ${GH}`).ok).toBe(false);
  });

  it("redacts captures in place before truncating", () => {
    const text = `prefix ${GH} suffix`;
    expect(sanitizeCapture(text, 100)).toBe("prefix [REDACTED] suffix");
    // Cutting inside the original secret's span must not expose a fragment of it.
    for (const max of [14, 20, 30, 40]) {
      const out = sanitizeCapture(text, max);
      expect(out).not.toContain("ghp_");
      expect(out).not.toContain("aaaa");
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });

  it("normalizes to NFC", () => {
    expect(sanitize("é")).toBe("é");
  });
});

describe("secret detectors (SPEC 10.3)", () => {
  it.each([
    ["aws-access-key-id", "key AKIAABCDEFGHIJKLMNOP here"],
    ["github-token", GH],
    ["slack-token", "xoxb-1234567890-abcdef"],
    ["anthropic-api-key", "sk-ant-" + "b".repeat(30)],
    ["openai-api-key", "sk-proj-" + "c".repeat(40)],
    ["private-key-block", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["authorization-header", "Authorization: Basic dXNlcjpwYXNzd29yZA=="],
    ["bearer-token", "send Bearer abcdefghijklmnopqrstuvwxyz123456"],
    ["cookie", "Cookie: session=abcdef1234567890"],
    ["url-credentials", "https://user:hunter2secret@example.com/repo.git"],
    ["generic-secret-assignment", "api_key = 'abcdefghijklmnop1234'"],
  ])("%s matches", (name, text) => {
    expect(detectSecrets(text)).toContain(name);
  });

  it.each([
    "Use an event log, not cr-sqlite, because it is dormant.",
    "The token budget for a micro brief is about 300.",
    "See https://github.com/kennylhilljr/ctxd for the repo.",
    "Authorization model: per-client tokens stored as hashes.",
  ])("does not match ordinary text: %s", (text) => {
    expect(detectSecrets(text)).toEqual([]);
  });

  it("redacts every occurrence", () => {
    expect(redactSecrets(`${GH} and ${GH}`)).toBe("[REDACTED] and [REDACTED]");
  });
});
