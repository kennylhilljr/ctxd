import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inboxSchedulePlist,
  inboxSchedulePlistPath,
  inboxScheduleStatus,
  installInboxSchedule,
  scheduleIntervalSeconds,
  uninstallInboxSchedule,
} from "../../src/cli/inbox-schedule.js";
import { lintPlist } from "../../src/cli/service.js";

/** `ctxd inbox schedule` (W7's approved follow-up). Every test uses an explicit scratch `path`, a
 * test-only `label` distinct from `dev.ctxd.inbox-pull`, and a scratch `home`, so these can safely
 * call the real `launchctl`/`plutil` without ever touching a real installed schedule. */

const TEST_LABEL = "dev.ctxd.inbox-pull.test";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "ctxd-inbox-schedule-"));
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("scheduleIntervalSeconds", () => {
  it("converts whole minutes to seconds", () => {
    expect(scheduleIntervalSeconds(1)).toBe(60);
    expect(scheduleIntervalSeconds(15)).toBe(900);
    expect(scheduleIntervalSeconds(1440)).toBe(86_400);
  });

  it("rejects anything that is not whole minutes in range", () => {
    expect(() => scheduleIntervalSeconds(0)).toThrow();
    expect(() => scheduleIntervalSeconds(-5)).toThrow();
    expect(() => scheduleIntervalSeconds(1441)).toThrow();
    expect(() => scheduleIntervalSeconds(1.5)).toThrow();
  });
});

describe("inboxSchedulePlist", () => {
  it("fills in the label, node binary, entry point, interval and log paths", () => {
    const xml = inboxSchedulePlist({
      label: TEST_LABEL,
      nodeBin: "/usr/local/bin/node",
      entryPoint: "/opt/ctxd/dist/cli/index.js",
      home: "/Users/test",
      minutes: 15,
    });
    expect(xml).toContain("<string>dev.ctxd.inbox-pull.test</string>");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/opt/ctxd/dist/cli/index.js</string>");
    expect(xml).toContain("<string>inbox</string>");
    expect(xml).toContain("<string>pull</string>");
    expect(xml).toContain("<key>StartInterval</key>");
    expect(xml).toContain("<integer>900</integer>");
    expect(xml).toContain("/Users/test/Library/Logs/ctxd/inbox-pull.log");
    expect(xml).toContain("/Users/test/Library/Logs/ctxd/inbox-pull.err.log");
    // An interval job must not also run at load or be kept alive: that would turn "every 15
    // minutes" into "immediately, then restart forever" (src/cli/service.ts's own job does that
    // deliberately; this one must not).
    expect(xml).not.toContain("<key>RunAtLoad</key>");
    expect(xml).not.toContain("<key>KeepAlive</key>");
    expect(xml).not.toContain("<key>StartCalendarInterval</key>");
  });

  it("includes --config and --data-dir only when given", () => {
    const bare = inboxSchedulePlist({ label: TEST_LABEL, home: "/Users/test", minutes: 15 });
    expect(bare).not.toContain("--config");
    expect(bare).not.toContain("--data-dir");

    const withPaths = inboxSchedulePlist({ label: TEST_LABEL, home: "/Users/test", minutes: 15, configPath: "/cfg/ctxd.toml", dataDir: "/data" });
    expect(withPaths).toContain("<string>--config</string>");
    expect(withPaths).toContain("<string>/cfg/ctxd.toml</string>");
    expect(withPaths).toContain("<string>--data-dir</string>");
    expect(withPaths).toContain("<string>/data</string>");
  });

  it("produces a plist plutil accepts", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    writeFileSync(path, inboxSchedulePlist({ label: TEST_LABEL, home, minutes: 15 }));
    expect(() => lintPlist(path)).not.toThrow();
  });

  it("refuses to write a plist for an out-of-range interval, rather than emitting a broken one", () => {
    expect(() => inboxSchedulePlist({ label: TEST_LABEL, home: "/Users/test", minutes: 0 })).toThrow();
  });
});

describe("installInboxSchedule / inboxScheduleStatus / uninstallInboxSchedule round trip", () => {
  it("installs, reports loaded status, then uninstalls cleanly", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    cleanup = () => uninstallInboxSchedule({ label: TEST_LABEL, path });

    const installed = installInboxSchedule({ label: TEST_LABEL, path, home, minutes: 15 });
    expect(installed.path).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(TEST_LABEL);

    const status = inboxScheduleStatus({ label: TEST_LABEL, path, home });
    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(true);

    const uninstalled = uninstallInboxSchedule({ label: TEST_LABEL, path, home });
    expect(uninstalled.removed).toBe(true);
    expect(existsSync(path)).toBe(false);

    const afterStatus = inboxScheduleStatus({ label: TEST_LABEL, path, home });
    expect(afterStatus.installed).toBe(false);
    expect(afterStatus.loaded).toBe(false);
  });

  it("reports not installed and not loaded for a label that was never installed", () => {
    const home = tmpHome();
    const path = inboxSchedulePlistPath("dev.ctxd.inbox-pull.never-installed", home);
    const status = inboxScheduleStatus({ label: "dev.ctxd.inbox-pull.never-installed", path, home });
    expect(status.installed).toBe(false);
    expect(status.loaded).toBe(false);
  });

  it("uninstall is a harmless no-op when nothing was installed", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    const result = uninstallInboxSchedule({ label: TEST_LABEL, path, home });
    expect(result.removed).toBe(false);
    expect(result.path).toBe(path);
  });
});
