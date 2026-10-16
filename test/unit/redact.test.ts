import { describe, expect, it } from "vitest";
import { detectSecrets, stripPrivate } from "../../src/security/redact.js";

describe("redaction", () => {
  it("strips private blocks", () => {
    expect(stripPrivate("keep <private>hide me</private> this")).toBe(
      "keep [private content removed] this",
    );
  });

  it("detects common secret formats", () => {
    expect(detectSecrets("key AKIAABCDEFGHIJKLMNOP here")).toContain("aws-access-key-id");
    expect(detectSecrets("ghp_" + "a".repeat(36))).toContain("github-token");
    expect(detectSecrets("-----BEGIN OPENSSH PRIVATE KEY-----")).toContain("private-key-block");
    expect(detectSecrets("api_key = 'abcdefghijklmnop1234'")).toContain("generic-secret-assignment");
  });

  it("passes ordinary text", () => {
    expect(detectSecrets("Use an event log, not cr-sqlite, because it is dormant.")).toEqual([]);
  });
});
