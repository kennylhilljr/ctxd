import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentPlistPath,
  agentStatus,
  buildAgentPlist,
  installAgent,
  loadedAgentDefinition,
  uninstallAgent,
  type LaunchdAgentSpec,
} from "../../src/cli/launchd.js";

/**
 * The shared launchd helper (W11), and the two bugs it exists to fix once rather than three
 * times. Every test uses a scratch `home`, an explicit scratch `path` and a test-only label, so
 * the real `plutil` and `launchctl` run against a throwaway job torn down in the same test; no
 * real ctxd agent is ever touched.
 */

const TEST_LABEL = "dev.ctxd.launchd.test";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "ctxd-launchd-"));
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function spec(over: Partial<LaunchdAgentSpec> = {}): LaunchdAgentSpec {
  return {
    label: TEST_LABEL,
    command: ["inbox", "pull"],
    logName: "probe",
    schedule: { kind: "interval", seconds: 900 },
    nodeBin: "/usr/bin/true", // a real executable, so launchd accepts the job
    entryPoint: "/opt/ctxd/dist/cli/index.js",
    home: "/Users/test",
    ...over,
  };
}

describe("buildAgentPlist", () => {
  it("writes each schedule kind with the keys launchd expects, and only those", () => {
    const keepalive = buildAgentPlist(spec({ schedule: { kind: "keepalive" } }));
    expect(keepalive).toContain("<key>RunAtLoad</key>");
    expect(keepalive).toContain("<key>KeepAlive</key>");
    expect(keepalive).not.toContain("StartInterval");
    expect(keepalive).not.toContain("StartCalendarInterval");

    const interval = buildAgentPlist(spec({ schedule: { kind: "interval", seconds: 900 } }));
    expect(interval).toContain("<key>StartInterval</key>");
    expect(interval).toContain("<integer>900</integer>");
    // On an interval job these two would mean "run now, then restart forever".
    expect(interval).not.toContain("<key>RunAtLoad</key>");
    expect(interval).not.toContain("<key>KeepAlive</key>");

    const calendar = buildAgentPlist(spec({ schedule: { kind: "calendar", hour: 3, minute: 15 } }));
    expect(calendar).toContain("<key>StartCalendarInterval</key>");
    expect(calendar).toContain("<integer>3</integer>");
    expect(calendar).toContain("<integer>15</integer>");
    expect(calendar).not.toContain("<key>StartInterval</key>");
  });

  it("refuses an interval that is not whole seconds, rather than emitting a broken plist", () => {
    expect(() => buildAgentPlist(spec({ schedule: { kind: "interval", seconds: 0 } }))).toThrow();
    expect(() => buildAgentPlist(spec({ schedule: { kind: "interval", seconds: 1.5 } }))).toThrow();
  });

  it("writes --config and --data-dir as absolute paths, since launchd gives the job no useful cwd", () => {
    const xml = buildAgentPlist(spec({ configPath: "relative/ctxd.toml", dataDir: "./data" }));
    expect(xml).toContain(`<string>${resolve("relative/ctxd.toml")}</string>`);
    expect(xml).toContain(`<string>${resolve("./data")}</string>`);
    // The relative forms must not survive into the plist at all.
    expect(xml).not.toContain("<string>relative/ctxd.toml</string>");
    expect(xml).not.toContain("<string>./data</string>");
  });

  it("leaves an already-absolute path alone", () => {
    const xml = buildAgentPlist(spec({ configPath: "/etc/ctxd/config.toml" }));
    expect(xml).toContain("<string>/etc/ctxd/config.toml</string>");
  });

  it("names the log files from logName, under the given home", () => {
    const xml = buildAgentPlist(spec({ logName: "inbox-pull", home: "/Users/test" }));
    expect(xml).toContain("/Users/test/Library/Logs/ctxd/inbox-pull.log");
    expect(xml).toContain("/Users/test/Library/Logs/ctxd/inbox-pull.err.log");
  });
});

describe("installAgent", () => {
  it("reinstalling applies the new definition, instead of leaving the loaded job on the old one", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    cleanup = () => uninstallAgent({ label: TEST_LABEL, path });

    installAgent({ ...spec({ home, dataDir: "/data/first" }), path });
    const first = loadedAgentDefinition(TEST_LABEL);
    expect(first).toBeDefined();
    expect(first).toContain("/data/first");

    // Same label, different arguments and interval. Before the unload-before-load fix, launchd
    // printed "Load failed: 5" *and exited 0*, so this silently kept serving the old definition.
    installAgent({ ...spec({ home, dataDir: "/data/second", schedule: { kind: "interval", seconds: 1800 } }), path });

    const second = loadedAgentDefinition(TEST_LABEL);
    expect(second).toBeDefined();
    expect(second).toContain("/data/second");
    expect(second).not.toContain("/data/first");
    // The interval itself is absent from `launchctl list` output (it reports only Label,
    // OnDemand, LastExitStatus, Program and ProgramArguments), so the plist on disk is where it
    // is checked; the arguments above are what prove the reload actually reached launchd.
    expect(readFileSync(path, "utf8")).toContain("<integer>1800</integer>");
    expect(agentStatus({ label: TEST_LABEL, path, home }).loaded).toBe(true);
  });

  it("installs, reports loaded status, then uninstalls cleanly", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    cleanup = () => uninstallAgent({ label: TEST_LABEL, path });

    const installed = installAgent({ ...spec({ home }), path });
    expect(installed).toEqual({ path, label: TEST_LABEL });
    expect(existsSync(path)).toBe(true);

    const status = agentStatus({ label: TEST_LABEL, path, home });
    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(true);

    expect(uninstallAgent({ label: TEST_LABEL, path, home })).toEqual({ removed: true, path });
    expect(existsSync(path)).toBe(false);
    expect(agentStatus({ label: TEST_LABEL, path, home }).loaded).toBe(false);
  });
});

describe("uninstallAgent and agentStatus", () => {
  it("uninstall is a harmless no-op when nothing was installed", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    expect(uninstallAgent({ label: TEST_LABEL, path, home })).toEqual({ removed: false, path });
  });

  it("reports not installed and not loaded for a label that was never installed", () => {
    const home = tmpHome();
    const label = "dev.ctxd.launchd.test.never-installed";
    const status = agentStatus({ label, path: agentPlistPath(label, home), home });
    expect(status.installed).toBe(false);
    expect(status.loaded).toBe(false);
    expect(loadedAgentDefinition(label)).toBeUndefined();
  });
});
