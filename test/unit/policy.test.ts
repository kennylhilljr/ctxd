import { describe, expect, it } from "vitest";
import { assertLoopback, mayRead, mayReplicate } from "../../src/security/policy.js";

describe("policies", () => {
  it("filters replication by scope policy and node role", () => {
    expect(mayReplicate("all", "roaming")).toBe(true);
    expect(mayReplicate("home", "home")).toBe(true);
    expect(mayReplicate("home", "roaming")).toBe(false);
    expect(mayReplicate("local", "home")).toBe(false);
  });

  it("hides local-only scopes from cloud vendors", () => {
    expect(mayRead("local-only", "anthropic")).toBe(false);
    expect(mayRead("local-only", "openai")).toBe(false);
    expect(mayRead("local-only", "local")).toBe(true);
    expect(mayRead("any", "openai")).toBe(true);
  });

  it("refuses non-loopback listeners", () => {
    expect(() => assertLoopback("127.0.0.1:7411")).not.toThrow();
    expect(() => assertLoopback("[::1]:7411")).not.toThrow();
    expect(() => assertLoopback("0.0.0.0:7411")).toThrow(/loopback/);
    expect(() => assertLoopback("100.64.0.5:7412")).toThrow(/loopback/);
  });
});
