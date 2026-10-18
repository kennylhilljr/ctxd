import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../../src/config/config.js";
import { run } from "../../src/cli/features.js";

/** Tests for `ctxd features` / `ctxd features set` (PRD-feature-flags-v1 FF-5). */

let logLines: string[] = [];
let errorLines: string[] = [];
beforeEach(() => {
  logLines = [];
  errorLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function freshConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxd-features-"));
  const path = join(dir, "ctxd.toml");
  const config = configSchema.parse({ node: { name: "air", role: "home" } });
  writeFileSync(path, stringify(config));
  return path;
}

describe("ctxd features (list)", () => {
  it("lists every registered flag with its effective value and source", () => {
    const path = freshConfigPath();
    expect(run(["--config", path])).toBe(0);
    expect(logLines.some((l) => l.includes("hooks") && l.includes("on") && l.includes("default"))).toBe(true);
    expect(logLines.some((l) => l.includes("hooks.prompt_search") && l.includes("off"))).toBe(true);
  });
});

describe("ctxd features set", () => {
  it("writes [features] into config.toml and the new value takes effect on the next read", () => {
    const path = freshConfigPath();
    expect(run(["set", "hooks.nudge", "off", "--config", path])).toBe(0);

    const written = parse(readFileSync(path, "utf8")) as { features?: Record<string, boolean> };
    expect(written.features).toEqual({ "hooks.nudge": false });

    logLines = [];
    expect(run(["--config", path])).toBe(0);
    expect(logLines.some((l) => l.startsWith("hooks.nudge") && l.includes("off") && l.includes("config"))).toBe(true);
  });

  it("round-trips an existing [features] table instead of clobbering it", () => {
    const path = freshConfigPath();
    run(["set", "hooks.nudge", "off", "--config", path]);
    run(["set", "metering", "off", "--config", path]);

    const written = parse(readFileSync(path, "utf8")) as { features?: Record<string, boolean> };
    expect(written.features).toEqual({ "hooks.nudge": false, metering: false });
  });

  it("rejects an unknown flag name without writing the file", () => {
    const path = freshConfigPath();
    const before = readFileSync(path, "utf8");
    expect(run(["set", "no.such.flag", "off", "--config", path])).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(errorLines.some((l) => l.includes("unknown flag"))).toBe(true);
  });

  it("rejects a missing or invalid on/off argument", () => {
    const path = freshConfigPath();
    expect(run(["set", "hooks.nudge", "--config", path])).toBe(1);
    expect(run(["set", "hooks.nudge", "maybe", "--config", path])).toBe(1);
  });
});
