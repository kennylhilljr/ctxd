import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installService,
  lintPlist,
  servicePlist,
  servicePlistPath,
  serviceStatus,
  uninstallService,
} from "../../src/cli/service.js";

/** `ctxd service` (SPEC v8 section 12, M4 slice 2). Every test uses an explicit scratch `path`,
 * a test-only `label` distinct from `dev.ctxd.server`, and a scratch `home`, so these can safely
 * call the real `launchctl`/`plutil` without ever touching the real running service. */

const TEST_LABEL = "dev.ctxd.server.test";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "ctxd-service-"));
}

// Cleans up any job this file's tests load, even if an assertion fails mid-test.
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("servicePlist", () => {
  it("fills in the label, node binary, entry point and log paths", () => {
    const xml = servicePlist({
      label: TEST_LABEL,
      nodeBin: "/usr/local/bin/node",
      entryPoint: "/opt/ctxd/dist/cli/index.js",
      home: "/Users/test",
    });
    expect(xml).toContain("<string>dev.ctxd.server.test</string>");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/opt/ctxd/dist/cli/index.js</string>");
    expect(xml).toContain("<string>server</string>");
    expect(xml).toContain("/Users/test/Library/Logs/ctxd/server.log");
    expect(xml).toContain("/Users/test/Library/Logs/ctxd/server.err.log");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>KeepAlive</key>");
  });
});

describe("lintPlist", () => {
  it("accepts a well-formed plist", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    writeFileSync(path, servicePlist({ label: TEST_LABEL, home }));
    expect(() => lintPlist(path)).not.toThrow();
  });

  it("rejects a malformed plist", () => {
    const home = tmpHome();
    const path = join(home, "bad.plist");
    writeFileSync(path, "<not-a-plist>");
    expect(() => lintPlist(path)).toThrow();
  });
});

describe("installService / serviceStatus / uninstallService round trip", () => {
  it("installs, reports loaded status, then uninstalls cleanly", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    cleanup = () => uninstallService({ label: TEST_LABEL, path });

    const installed = installService({ label: TEST_LABEL, path, home });
    expect(installed.path).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(TEST_LABEL);

    const status = serviceStatus({ label: TEST_LABEL, path, home });
    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(true);

    const uninstalled = uninstallService({ label: TEST_LABEL, path, home });
    expect(uninstalled.removed).toBe(true);
    expect(existsSync(path)).toBe(false);

    const afterStatus = serviceStatus({ label: TEST_LABEL, path, home });
    expect(afterStatus.installed).toBe(false);
    expect(afterStatus.loaded).toBe(false);
  });

  it("reports not installed and not loaded for a label that was never installed", () => {
    const home = tmpHome();
    const path = servicePlistPath("dev.ctxd.server.never-installed", home);
    const status = serviceStatus({ label: "dev.ctxd.server.never-installed", path, home });
    expect(status.installed).toBe(false);
    expect(status.loaded).toBe(false);
  });

  it("uninstall is a harmless no-op when nothing was installed", () => {
    const home = tmpHome();
    const path = join(home, "agent.plist");
    const result = uninstallService({ label: TEST_LABEL, path, home });
    expect(result.removed).toBe(false);
    expect(result.path).toBe(path);
  });
});
