import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupSchedulePlist,
  backupSchedulePlistPath,
  backupScheduleStatus,
  installBackupSchedule,
  parseScheduleTime,
  uninstallBackupSchedule,
} from "../../src/cli/backup-schedule.js";
import { lintPlist } from "../../src/cli/service.js";

/** `ctxd backup schedule` (W4). Every test uses an explicit scratch `path`, a test-only `label`
 * distinct from `dev.ctxd.backup`, and a scratch `home`, so these can safely call the real
 * `launchctl`/`plutil` without ever touching the real running schedule. */

const TEST_LABEL = "dev.ctxd.backup.test";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "ctxd-backup-schedule-"));
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("parseScheduleTime", () => {
  it("parses a valid HH:MM", () => {
    expect(parseScheduleTime("03:15")).toEqual({ hour: 3, minute: 15 });
    expect(parseScheduleTime("23:59")).toEqual({ hour: 23, minute: 59 });
  });

  it("rejects anything else", () => {
    expect(() => parseScheduleTime("25:00")).toThrow();
    expect(() => parseScheduleTime("3:15")).toThrow();
    expect(() => parseScheduleTime("not-a-time")).toThrow();
  });
});

describe("backupSchedulePlist", () => {
  it("fills in the label, node binary, entry point, time and log paths", () => {
    const xml = backupSchedulePlist({
      label: TEST_LABEL,
      nodeBin: "/usr/local/bin/node",
      entryPoint: "/opt/ctxd/dist/cli/index.js",
      home: "/Users/test",
      time: "03:15",
    });
    expect(xml).toContain("<string>dev.ctxd.backup.test</string>");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/opt/ctxd/dist/cli/index.js</string>");
    expect(xml).toContain("<string>backup</string>");
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain("<integer>3</integer>");
    expect(xml).toContain("<integer>15</integer>");
    expect(xml).toContain("/Users/test/Library/Logs/ctxd/backup.log");
    expect(xml).toContain("/Users/test/Library/Logs/ctxd/backup.err.log");
    expect(xml).not.toContain("<key>RunAtLoad</key>");
    expect(xml).not.toContain("<key>KeepAlive</key>");
  });

  it("includes --config and --data-dir only when given", () => {
    const bare = backupSchedulePlist({ label: TEST_LABEL, home: "/Users/test", time: "03:15" });
    expect(bare).not.toContain("--config");
    expect(bare).not.toContain("--data-dir");

    const withPaths = backupSchedulePlist({ label: TEST_LABEL, home: "/Users/test", time: "03:15", configPath: "/cfg/ctxd.toml", dataDir: "/data" });
    expect(withPaths).toContain("<string>--config</string>");
    expect(withPaths).toContain("<string>/cfg/ctxd.toml</string>");
    expect(withPaths).toContain("<string>--data-dir</string>");
    expect(withPaths).toContain("<string>/data</string>");
  });

  it("produces a plist plutil accepts", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    writeFileSync(path, backupSchedulePlist({ label: TEST_LABEL, home, time: "03:15" }));
    expect(() => lintPlist(path)).not.toThrow();
  });
});

describe("installBackupSchedule / backupScheduleStatus / uninstallBackupSchedule round trip", () => {
  it("installs, reports loaded status, then uninstalls cleanly", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    cleanup = () => uninstallBackupSchedule({ label: TEST_LABEL, path });

    const installed = installBackupSchedule({ label: TEST_LABEL, path, home, time: "03:15" });
    expect(installed.path).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(TEST_LABEL);

    const status = backupScheduleStatus({ label: TEST_LABEL, path, home });
    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(true);

    const uninstalled = uninstallBackupSchedule({ label: TEST_LABEL, path, home });
    expect(uninstalled.removed).toBe(true);
    expect(existsSync(path)).toBe(false);

    const afterStatus = backupScheduleStatus({ label: TEST_LABEL, path, home });
    expect(afterStatus.installed).toBe(false);
    expect(afterStatus.loaded).toBe(false);
  });

  it("reports not installed and not loaded for a label that was never installed", () => {
    const home = tmpHome();
    const path = backupSchedulePlistPath("dev.ctxd.backup.never-installed", home);
    const status = backupScheduleStatus({ label: "dev.ctxd.backup.never-installed", path, home });
    expect(status.installed).toBe(false);
    expect(status.loaded).toBe(false);
  });

  it("uninstall is a harmless no-op when nothing was installed", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    const result = uninstallBackupSchedule({ label: TEST_LABEL, path, home });
    expect(result.removed).toBe(false);
    expect(result.path).toBe(path);
  });
});
