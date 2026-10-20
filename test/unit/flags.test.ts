import { describe, expect, it } from "vitest";
import { CtxdError } from "../../src/core/errors.js";
import { FLAG_REGISTRY, envVarName, isFlagOn, requireFlag, resolveFlags, resolveFlagsDetailed } from "../../src/config/flags.js";

/** Tests for the feature-flag registry and resolution (PRD-feature-flags-v1, FF-1 to FF-8). */

describe("FLAG_REGISTRY", () => {
  it("has a non-empty default, milestone, description and off-behavior for every flag, with no duplicate names", () => {
    const names = new Set<string>();
    for (const def of FLAG_REGISTRY) {
      expect(typeof def.default).toBe("boolean");
      expect(def.milestone.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.offMeans.length).toBeGreaterThan(0);
      expect(names.has(def.name)).toBe(false);
      names.add(def.name);
    }
  });

  it("every parent reference names a real flag in the registry", () => {
    const names = new Set(FLAG_REGISTRY.map((d) => d.name));
    for (const def of FLAG_REGISTRY) {
      if (def.parent) expect(names.has(def.parent)).toBe(true);
    }
  });
});

describe("envVarName", () => {
  it("upper-cases the name and turns dots into underscores (PRD-feature-flags-v1 section 2)", () => {
    expect(envVarName("hooks")).toBe("CTXD_FEATURE_HOOKS");
    expect(envVarName("hooks.nudge")).toBe("CTXD_FEATURE_HOOKS_NUDGE");
    expect(envVarName("review.remembered_rules")).toBe("CTXD_FEATURE_REVIEW_REMEMBERED_RULES");
    expect(envVarName("mobile_inbox")).toBe("CTXD_FEATURE_MOBILE_INBOX");
    expect(envVarName("mobile_inbox.publish_briefs")).toBe("CTXD_FEATURE_MOBILE_INBOX_PUBLISH_BRIEFS");
  });
});

describe("resolveFlags: three layers, last one wins", () => {
  it("falls back to the registry default with no config and no environment", () => {
    const flags = resolveFlags(undefined, {});
    expect(isFlagOn(flags, "hooks")).toBe(true);
    expect(isFlagOn(flags, "hooks.prompt_search")).toBe(false); // M2's one off-by-default flag
  });

  it("a config value overrides the default", () => {
    const flags = resolveFlags({ features: { "hooks.nudge": false } }, {});
    expect(isFlagOn(flags, "hooks.nudge")).toBe(false);

    const inboxFlags = resolveFlags({ features: { mobile_inbox: false, "mobile_inbox.publish_briefs": true } }, {});
    expect(isFlagOn(inboxFlags, "mobile_inbox")).toBe(false);
    expect(isFlagOn(inboxFlags, "mobile_inbox.publish_briefs")).toBe(false);
  });

  it("an environment value overrides both the default and the config file", () => {
    const flags = resolveFlags({ features: { "hooks.nudge": false } }, { CTXD_FEATURE_HOOKS_NUDGE: "1" });
    expect(isFlagOn(flags, "hooks.nudge")).toBe(true);
  });

  it("only the literal strings 0 and 1 are recognized in the environment; anything else is ignored", () => {
    const flags = resolveFlags(undefined, { CTXD_FEATURE_METERING: "false" });
    expect(isFlagOn(flags, "metering")).toBe(true); // unrecognized value: falls back to the default
  });

  it("an unregistered flag name is treated as on (nothing reads it, so it never gates anything in practice)", () => {
    const flags = resolveFlags(undefined, {});
    expect(isFlagOn(flags, "no.such.flag")).toBe(true);
  });
});

describe("parent cascade (FF-4)", () => {
  it("a parent turned off silences its children regardless of their own setting", () => {
    const flags = resolveFlags({ features: { hooks: false, "hooks.nudge": true } }, {});
    expect(isFlagOn(flags, "hooks.nudge")).toBe(false);
  });

  it("a parent left on does not affect a child explicitly turned off", () => {
    const flags = resolveFlags({ features: { "hooks.nudge": false } }, {});
    expect(isFlagOn(flags, "hooks")).toBe(true);
    expect(isFlagOn(flags, "hooks.nudge")).toBe(false);
  });
});

describe("resolveFlagsDetailed: ctxd features' source reporting", () => {
  it("reports default, config and environment correctly for three different flags at once", () => {
    const resolved = resolveFlagsDetailed({ features: { "hooks.nudge": false } }, { CTXD_FEATURE_METERING: "0" });
    const byName = new Map(resolved.map((r) => [r.def.name, r]));
    expect(byName.get("hooks.session_start")).toMatchObject({ value: true, source: "default" });
    expect(byName.get("hooks.nudge")).toMatchObject({ value: false, source: "config" });
    expect(byName.get("metering")).toMatchObject({ value: false, source: "environment" });
  });
});

describe("requireFlag (FF-7)", () => {
  it("throws NOT_ALLOWED with the exact hint text when the named flag is off", () => {
    const flags = resolveFlags({ features: { metering: false } }, {});
    try {
      requireFlag(flags, "metering");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CtxdError);
      const envelope = (err as CtxdError).toJSON();
      expect(envelope.error.code).toBe("NOT_ALLOWED");
      expect(envelope.error.hint).toBe("Feature `metering` is disabled on this machine.");
    }
  });

  it("does nothing when the flag is on", () => {
    const flags = resolveFlags(undefined, {});
    expect(() => requireFlag(flags, "hooks")).not.toThrow();
  });

  it("treats a missing flags map as every flag being on (pre-M3 call sites)", () => {
    expect(isFlagOn(undefined, "hooks")).toBe(true);
    expect(() => requireFlag(undefined, "hooks")).not.toThrow();
  });
});
