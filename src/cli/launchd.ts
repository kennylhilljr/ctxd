/**
 * The one place that writes, loads, inspects and removes a ctxd launchd agent. Three commands
 * install agents (`ctxd service`, `ctxd backup schedule`, `ctxd inbox schedule`) and before this
 * each carried its own near-identical copy of the plist generation, `plutil` lint, `launchctl`
 * calls and status parsing. W7's plan listed the extraction once a second real instance existed;
 * W8 added the third, and two bugs then needed fixing in all three at once, which is what finally
 * justified it.
 *
 * The agents differ only in what they launch and in when launchd should run it, which is the
 * `LaunchdSchedule` union below. Everything else is shared, including both fixes:
 *
 * - **Reinstall actually applies.** Loading a label launchd already knows prints
 *   `Load failed: 5: Input/output error` *and exits 0* (verified on this macOS version), so the
 *   old code wrote the new plist, threw launchd's complaint away because the exit code looked
 *   fine, and left the running job on its previous definition with nothing to show for it.
 *   Changing an interval or a calendar time and reinstalling therefore did nothing at all.
 *   `installAgent` now unloads first, ignoring the error when nothing was loaded, and then
 *   inspects `load`'s own output rather than trusting its exit code.
 * - **Paths in a plist are absolute.** launchd runs a job with no useful working directory, so a
 *   relative `--config ./ctxd.toml` baked into `ProgramArguments` would simply not resolve at run
 *   time. Both paths are resolved before they are written.
 *
 * Tests always pass an explicit `label`, `path` and `home`, so they drive the real `plutil` and
 * `launchctl` against a scratch-pathed, test-labeled job and tear it down in the same run; they
 * never touch a real installed agent.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

/** When launchd should run the job. */
export type LaunchdSchedule =
  /** Start at load and restart if it exits: the long-running server. */
  | { kind: "keepalive" }
  /** Every `seconds`: work that should happen regularly, like emptying the mobile inbox. */
  | { kind: "interval"; seconds: number }
  /** Once a day at this local time: work with a right time of day, like a backup. */
  | { kind: "calendar"; hour: number; minute: number };

export interface LaunchdAgentSpec {
  label: string;
  /** The ctxd subcommand to run, e.g. `["inbox", "pull"]` or `["server"]`. */
  command: string[];
  /** Log basename under `~/Library/Logs/ctxd`, e.g. `inbox-pull` for `inbox-pull.log`. */
  logName: string;
  schedule: LaunchdSchedule;
  nodeBin?: string;
  entryPoint?: string;
  home?: string;
  /** Passed to the job as `--config`; resolved to an absolute path first. */
  configPath?: string;
  /** Passed to the job as `--data-dir`; resolved to an absolute path first. */
  dataDir?: string;
}

/** `dist/cli/index.js`, the real entry point every ctxd subcommand resolves to, sibling to this compiled module. */
export function ctxdEntryPoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

export function agentPlistPath(label: string, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/** `plutil -lint`: throws with plutil's own message if the plist is not well-formed. */
export function lintPlist(path: string): void {
  execFileSync("plutil", ["-lint", path], { encoding: "utf8" });
}

function scheduleXml(schedule: LaunchdSchedule): string {
  switch (schedule.kind) {
    case "keepalive":
      return "  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>";
    case "interval":
      if (!Number.isInteger(schedule.seconds) || schedule.seconds < 1) {
        throw new Error(`invalid launchd interval "${schedule.seconds}"; expected whole seconds, 1 or more`);
      }
      return `  <key>StartInterval</key>\n  <integer>${schedule.seconds}</integer>`;
    case "calendar":
      return `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>${schedule.hour}</integer>\n    <key>Minute</key>\n    <integer>${schedule.minute}</integer>\n  </dict>`;
  }
}

export function buildAgentPlist(spec: LaunchdAgentSpec): string {
  const nodeBin = spec.nodeBin ?? process.execPath;
  const entryPoint = spec.entryPoint ?? ctxdEntryPoint();
  const home = spec.home ?? homedir();
  const args = [nodeBin, entryPoint, ...spec.command];
  // Absolute, always: launchd gives the job no useful working directory, so a relative path here
  // would be resolved against whatever that happens to be.
  if (spec.configPath) args.push("--config", resolve(spec.configPath));
  if (spec.dataDir) args.push("--data-dir", resolve(spec.dataDir));
  const argLines = args.map((a) => `    <string>${a}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${spec.label}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
${scheduleXml(spec.schedule)}
  <key>StandardOutPath</key>
  <string>${home}/Library/Logs/ctxd/${spec.logName}.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/Library/Logs/ctxd/${spec.logName}.err.log</string>
</dict>
</plist>
`;
}

export interface AgentInstallResult {
  path: string;
  label: string;
}

/**
 * Writes and lints the plist, creates the log directory, then reloads it, so a reinstall really
 * applies the new definition (see this module's header for why `load` alone does not).
 *
 * `load`'s exit code cannot be trusted: it is 0 even when launchd refuses the job and prints
 * `Load failed: ...`. So its output is captured and checked, turning what used to be a silent
 * failure into an error the caller can report.
 */
export function installAgent(spec: LaunchdAgentSpec & { path?: string }): AgentInstallResult {
  const home = spec.home ?? homedir();
  const path = spec.path ?? agentPlistPath(spec.label, spec.home);
  mkdirSync(join(home, "Library", "Logs", "ctxd"), { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildAgentPlist(spec));
  lintPlist(path);
  try {
    execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
  } catch {
    // Nothing was loaded for this label (a first install, or after a crash or manual unload).
  }
  // spawnSync, not execFileSync: the complaint can arrive on either stream, and only spawnSync
  // hands back both.
  const loaded = spawnSync("launchctl", ["load", path], { encoding: "utf8" });
  const complaint = `${loaded.stdout ?? ""}${loaded.stderr ?? ""}`.trim();
  if (loaded.status !== 0 || /Load failed/i.test(complaint)) {
    throw new Error(`launchctl refused ${spec.label}: ${complaint || `exit ${loaded.status}`}`);
  }
  return { path, label: spec.label };
}

export interface AgentUninstallResult {
  removed: boolean;
  path: string;
}

export function uninstallAgent(opts: { label: string; path?: string; home?: string }): AgentUninstallResult {
  const path = opts.path ?? agentPlistPath(opts.label, opts.home);
  if (!existsSync(path)) return { removed: false, path };
  try {
    execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
  } catch {
    // Already not loaded: still remove the file.
  }
  unlinkSync(path);
  return { removed: true, path };
}

export interface AgentStatus {
  installed: boolean;
  path: string;
  loaded: boolean;
  /** Only a keepalive job has one between runs; an interval or calendar job normally does not. */
  pid?: number;
  lastExitStatus?: number;
}

/** Parses `launchctl list <label>`'s simple key/value block; absent entirely (not loaded) is reported, not thrown. */
export function agentStatus(opts: { label: string; path?: string; home?: string }): AgentStatus {
  const path = opts.path ?? agentPlistPath(opts.label, opts.home);
  const installed = existsSync(path);
  try {
    const output = execFileSync("launchctl", ["list", opts.label], { encoding: "utf8" });
    const pid = /"PID"\s*=\s*(\d+)/.exec(output)?.[1];
    const lastExitStatus = /"LastExitStatus"\s*=\s*(\d+)/.exec(output)?.[1];
    return { installed, path, loaded: true, pid: pid ? Number(pid) : undefined, lastExitStatus: lastExitStatus ? Number(lastExitStatus) : undefined };
  } catch {
    return { installed, path, loaded: false };
  }
}

/**
 * The raw `launchctl list <label>` block for a loaded label, or undefined when it is not loaded.
 *
 * This is how a test proves a reinstall actually reached launchd rather than only rewriting the
 * file. Note what the block does and does not contain: `Label`, `OnDemand`, `LastExitStatus`,
 * `Program` and `ProgramArguments` are there, but **the schedule is not** (no `StartInterval`, no
 * `StartCalendarInterval`). So a changed interval is only observable in the plist on disk, while a
 * changed argument is observable here, in the definition launchd is really holding.
 */
export function loadedAgentDefinition(label: string): string | undefined {
  const listed = spawnSync("launchctl", ["list", label], { encoding: "utf8" });
  return listed.status === 0 && listed.stdout ? listed.stdout : undefined;
}
