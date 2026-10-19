/**
 * `ctxd service install|uninstall|status` (SPEC v8 section 12, PRD-v7 M4): a launchd agent that
 * runs `ctxd server` at login and keeps it alive, replacing the by-hand steps from the owner's
 * earlier setup session with an idempotent, scriptable command.
 *
 * The plist is generated, not read from `deploy/launchd/dev.ctxd.server.plist`: that file is a
 * static reference for someone installing by hand (SPEC comment: "replace USERNAME"), but the
 * real paths it needs, the node binary and the installed entry point, are only known at install
 * time (exactly the two values that needed editing by hand before; see the lesson this slice's
 * handoff records). `process.execPath` and this module's own directory give both without any
 * `PATH` lookup, `which`, or `readlink` guesswork.
 *
 * Tests always pass an explicit `path`, `label` and `home`, so they install and load a real but
 * harmless, scratch-pathed, test-labeled job and tear it down in the same run; they never touch
 * `~/Library/LaunchAgents/dev.ctxd.server.plist` or the real running service.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const SERVICE_LABEL = "dev.ctxd.server";

export interface ServicePlistOptions {
  label?: string;
  nodeBin?: string;
  entryPoint?: string;
  home?: string;
}

/** `dist/cli/index.js`, the real entry point `server` resolves to, sibling to this compiled module. */
function ctxdEntryPoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

export function servicePlistPath(label: string = SERVICE_LABEL, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/** The launchd agent `deploy/launchd/dev.ctxd.server.plist` describes, with this install's real paths filled in. */
export function servicePlist(opts: ServicePlistOptions = {}): string {
  const label = opts.label ?? SERVICE_LABEL;
  const nodeBin = opts.nodeBin ?? process.execPath;
  const entryPoint = opts.entryPoint ?? ctxdEntryPoint();
  const home = opts.home ?? homedir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${entryPoint}</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${home}/Library/Logs/ctxd/server.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/Library/Logs/ctxd/server.err.log</string>
</dict>
</plist>
`;
}

/** `plutil -lint`: throws with plutil's own message if the plist is not well-formed. */
export function lintPlist(path: string): void {
  execFileSync("plutil", ["-lint", path], { encoding: "utf8" });
}

export interface InstallResult {
  path: string;
  label: string;
}

/** Writes and lints the plist, creates the log directory, then loads it with `launchctl load`. Idempotent: loading an already-loaded label is a harmless no-op for launchd. */
export function installService(opts: ServicePlistOptions & { path?: string } = {}): InstallResult {
  const label = opts.label ?? SERVICE_LABEL;
  const path = opts.path ?? servicePlistPath(label, opts.home);
  const home = opts.home ?? homedir();
  mkdirSync(join(home, "Library", "Logs", "ctxd"), { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, servicePlist(opts));
  lintPlist(path);
  execFileSync("launchctl", ["load", path]);
  return { path, label };
}

export interface UninstallResult {
  removed: boolean;
  path: string;
}

export function uninstallService(opts: { label?: string; path?: string; home?: string } = {}): UninstallResult {
  const label = opts.label ?? SERVICE_LABEL;
  const path = opts.path ?? servicePlistPath(label, opts.home);
  if (!existsSync(path)) return { removed: false, path };
  try {
    execFileSync("launchctl", ["unload", path]);
  } catch {
    // Already not loaded (for example, after a crash or a manual unload): still remove the file.
  }
  unlinkSync(path);
  return { removed: true, path };
}

export interface ServiceStatus {
  installed: boolean;
  path: string;
  loaded: boolean;
  pid?: number;
  lastExitStatus?: number;
}

/** Parses `launchctl list <label>`'s simple key/value block; absent entirely (not loaded) is reported, not thrown. */
export function serviceStatus(opts: { label?: string; path?: string; home?: string } = {}): ServiceStatus {
  const label = opts.label ?? SERVICE_LABEL;
  const path = opts.path ?? servicePlistPath(label, opts.home);
  const installed = existsSync(path);
  try {
    const output = execFileSync("launchctl", ["list", label], { encoding: "utf8" });
    const pid = /"PID"\s*=\s*(\d+)/.exec(output)?.[1];
    const lastExitStatus = /"LastExitStatus"\s*=\s*(\d+)/.exec(output)?.[1];
    return { installed, path, loaded: true, pid: pid ? Number(pid) : undefined, lastExitStatus: lastExitStatus ? Number(lastExitStatus) : undefined };
  } catch {
    return { installed, path, loaded: false };
  }
}

function usage(): string {
  return "Usage: ctxd service <install|uninstall|status>";
}

export function run(argv: string[]): number {
  const [sub] = argv;
  if (sub === "install") {
    try {
      const result = installService();
      console.log(`ctxd service: installed ${result.label} at ${result.path} and loaded it.`);
      return 0;
    } catch (err) {
      console.error(`ctxd service: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (sub === "uninstall") {
    const result = uninstallService();
    console.log(result.removed ? `ctxd service: removed ${result.path}.` : `ctxd service: ${result.path} was not installed; nothing to do.`);
    return 0;
  }
  if (sub === "status") {
    const status = serviceStatus();
    if (!status.installed) {
      console.log(`ctxd service: not installed (no plist at ${status.path}).`);
    } else if (!status.loaded) {
      console.log(`ctxd service: installed at ${status.path}, but not loaded.`);
    } else {
      const pidText = status.pid !== undefined ? `, pid ${status.pid}` : "";
      const exitText = status.lastExitStatus !== undefined ? `, last exit ${status.lastExitStatus}` : "";
      console.log(`ctxd service: installed at ${status.path}, loaded${pidText}${exitText}.`);
    }
    return 0;
  }
  console.error(usage());
  return 1;
}
