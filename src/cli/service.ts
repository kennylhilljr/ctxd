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
import { homedir } from "node:os";
import { agentPlistPath, agentStatus, buildAgentPlist, installAgent, lintPlist, uninstallAgent } from "./launchd.js";

export { lintPlist };

export const SERVICE_LABEL = "dev.ctxd.server";

export interface ServicePlistOptions {
  label?: string;
  nodeBin?: string;
  entryPoint?: string;
  home?: string;
}

export function servicePlistPath(label: string = SERVICE_LABEL, home: string = homedir()): string {
  return agentPlistPath(label, home);
}

/** The launchd agent `deploy/launchd/dev.ctxd.server.plist` describes, with this install's real paths filled in. The one keepalive agent ctxd installs: it runs at load and is restarted if it exits, unlike the two scheduled ones. */
export function servicePlist(opts: ServicePlistOptions = {}): string {
  return buildAgentPlist({
    label: opts.label ?? SERVICE_LABEL,
    command: ["server"],
    logName: "server",
    schedule: { kind: "keepalive" },
    ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
    ...(opts.entryPoint ? { entryPoint: opts.entryPoint } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });
}

export interface InstallResult {
  path: string;
  label: string;
}

/** Writes and lints the plist, creates the log directory, then reloads the agent so a reinstall really applies (src/cli/launchd.ts's `installAgent`). */
export function installService(opts: ServicePlistOptions & { path?: string } = {}): InstallResult {
  const label = opts.label ?? SERVICE_LABEL;
  return installAgent({
    label,
    command: ["server"],
    logName: "server",
    schedule: { kind: "keepalive" },
    ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
    ...(opts.entryPoint ? { entryPoint: opts.entryPoint } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.path ? { path: opts.path } : {}),
  });
}

export interface UninstallResult {
  removed: boolean;
  path: string;
}

export function uninstallService(opts: { label?: string; path?: string; home?: string } = {}): UninstallResult {
  return uninstallAgent({
    label: opts.label ?? SERVICE_LABEL,
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });
}

export interface ServiceStatus {
  installed: boolean;
  path: string;
  loaded: boolean;
  pid?: number;
  lastExitStatus?: number;
}

/** Parses `launchctl list <label>`'s simple key/value block; absent entirely (not loaded) is reported, not thrown. Unlike the two scheduled agents, this one normally does hold a PID between runs. */
export function serviceStatus(opts: { label?: string; path?: string; home?: string } = {}): ServiceStatus {
  return agentStatus({
    label: opts.label ?? SERVICE_LABEL,
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });
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
