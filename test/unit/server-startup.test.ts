import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/store/db.js";
import { run } from "../../src/cli/server.js";

/** Tests for `ctxd server`'s startup integrity checks (SPEC v8 section 12). Every case here
 * returns before any listener starts, so it is safe to call `run()` directly. */

let errorLines: string[] = [];
beforeEach(() => {
  errorLines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function tmpPaths(): { configPath: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ctxd-server-startup-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  return { configPath: join(configDir, "ctxd.toml"), dataDir: join(root, "data") };
}

describe("ctxd server startup (SPEC v8 section 12)", () => {
  it("refuses to start with no config and points to ctxd init", async () => {
    const { configPath, dataDir } = tmpPaths();
    const code = await run(["--config", configPath, "--data-dir", dataDir]);
    expect(code).toBe(1);
    expect(errorLines.join("\n")).toContain("no config found");
    expect(errorLines.join("\n")).toContain("ctxd init");
  });

  it("refuses to start with a missing database once a config exists, and points to doctor/restore, not init", async () => {
    const { configPath, dataDir } = tmpPaths();
    writeFileSync(configPath, `[node]\nname = "test"\nrole = "home"\ndata_dir = "${dataDir}"\n`);
    const code = await run(["--config", configPath, "--data-dir", dataDir]);
    expect(code).toBe(1);
    const output = errorLines.join("\n");
    expect(output).toContain("is missing");
    expect(output).toContain("ctxd doctor");
    expect(output).toContain("ctxd restore");
    expect(output).not.toContain('"ctxd init" first');
  });

  it("refuses to start over a corrupted database and points to doctor/restore", async () => {
    const { configPath, dataDir } = tmpPaths();
    writeFileSync(configPath, `[node]\nname = "test"\nrole = "home"\ndata_dir = "${dataDir}"\n`);
    const dbPath = join(dataDir, "ctxd.db");
    mkdirSync(dataDir, { recursive: true });
    openDatabase(dbPath, { create: true }).close();
    const fd = openSync(dbPath, "r+");
    const garbage = Buffer.from("not a valid sqlite page");
    writeSync(fd, garbage, 0, garbage.length, 100);
    closeSync(fd);

    const code = await run(["--config", configPath, "--data-dir", dataDir]);
    expect(code).toBe(1);
    const output = errorLines.join("\n");
    // This level of corruption breaks even openDatabase's own pragma calls, before
    // checkDatabaseIntegrity's quick_check ever runs; either layer must still point here.
    expect(output).toContain("ctxd doctor");
    expect(output).toContain("ctxd restore");
  });

  it("refuses to start a database with no node identity", async () => {
    const { configPath, dataDir } = tmpPaths();
    writeFileSync(configPath, `[node]\nname = "test"\nrole = "home"\ndata_dir = "${dataDir}"\n`);
    mkdirSync(dataDir, { recursive: true });
    openDatabase(join(dataDir, "ctxd.db"), { create: true }).close();

    const code = await run(["--config", configPath, "--data-dir", dataDir]);
    expect(code).toBe(1);
    expect(errorLines.join("\n")).toContain("no node identity found");
  });
});
