/**
 * `ctxd backup schedule install|uninstall|status` (W4): a launchd agent that runs `ctxd backup`
 * unattended, on `[backup] schedule` (default 03:15 local). Mirrors `src/cli/service.ts`'s own
 * plist generation and `lintPlist` almost exactly; the two differ only in what they launch and
 * how launchd is told to run it (`StartCalendarInterval` here, `RunAtLoad`/`KeepAlive` there),
 * so this module reuses `lintPlist` rather than duplicating it.
 *
 * Tests always pass an explicit `path`, `label` and `home`, so they install and load a real but
 * harmless, scratch-pathed, test-labeled job and tear it down in the same run; they never touch
 * `~/Library/LaunchAgents/dev.ctxd.backup.plist` or run a real backup.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { lintPlist } from "./service.js";

export const BACKUP_SCHEDULE_LABEL = "dev.ctxd.backup";

export interface BackupSchedulePlistOptions {
  label?: string;
  nodeBin?: string;
  entryPoint?: string;
  home?: string;
  /** "HH:MM" local, matching `config.backup.schedule`'s own validation. */
  time: string;
  configPath?: string;
  dataDir?: string;
}

function ctxdEntryPoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

export function backupSchedulePlistPath(label: string = BACKUP_SCHEDULE_LABEL, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/** Parses the config-validated "HH:MM" into launchd's StartCalendarInterval Hour/Minute integers. */
export function parseScheduleTime(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`invalid backup schedule time "${time}"; expected HH:MM`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function backupSchedulePlist(opts: BackupSchedulePlistOptions): string {
  const label = opts.label ?? BACKUP_SCHEDULE_LABEL;
  const nodeBin = opts.nodeBin ?? process.execPath;
  const entryPoint = opts.entryPoint ?? ctxdEntryPoint();
  const home = opts.home ?? homedir();
  const { hour, minute } = parseScheduleTime(opts.time);
  const args = [nodeBin, entryPoint, "backup"];
  if (opts.configPath) args.push("--config", opts.configPath);
  if (opts.dataDir) args.push("--data-dir", opts.dataDir);
  const argLines = args.map((a) => `    <string>${a}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${home}/Library/Logs/ctxd/backup.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/Library/Logs/ctxd/backup.err.log</string>
</dict>
</plist>
`;
}

export interface BackupScheduleInstallResult {
  path: string;
  label: string;
}

/** Writes and lints the plist, creates the log directory, then loads it with `launchctl load`. Idempotent, same as `installService`. */
export function installBackupSchedule(opts: BackupSchedulePlistOptions & { path?: string }): BackupScheduleInstallResult {
  const label = opts.label ?? BACKUP_SCHEDULE_LABEL;
  const path = opts.path ?? backupSchedulePlistPath(label, opts.home);
  const home = opts.home ?? homedir();
  mkdirSync(join(home, "Library", "Logs", "ctxd"), { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, backupSchedulePlist(opts));
  lintPlist(path);
  execFileSync("launchctl", ["load", path]);
  return { path, label };
}

export interface BackupScheduleUninstallResult {
  removed: boolean;
  path: string;
}

export function uninstallBackupSchedule(opts: { label?: string; path?: string; home?: string } = {}): BackupScheduleUninstallResult {
  const label = opts.label ?? BACKUP_SCHEDULE_LABEL;
  const path = opts.path ?? backupSchedulePlistPath(label, opts.home);
  if (!existsSync(path)) return { removed: false, path };
  try {
    execFileSync("launchctl", ["unload", path]);
  } catch {
    // Already not loaded: still remove the file.
  }
  unlinkSync(path);
  return { removed: true, path };
}

export interface BackupScheduleStatus {
  installed: boolean;
  path: string;
  loaded: boolean;
  lastExitStatus?: number;
}

/** Parses `launchctl list <label>`'s simple key/value block; absent entirely (not loaded) is reported, not thrown. A scheduled job has no PID between runs, so unlike `serviceStatus` this never reports one. */
export function backupScheduleStatus(opts: { label?: string; path?: string; home?: string } = {}): BackupScheduleStatus {
  const label = opts.label ?? BACKUP_SCHEDULE_LABEL;
  const path = opts.path ?? backupSchedulePlistPath(label, opts.home);
  const installed = existsSync(path);
  try {
    const output = execFileSync("launchctl", ["list", label], { encoding: "utf8" });
    const lastExitStatus = /"LastExitStatus"\s*=\s*(\d+)/.exec(output)?.[1];
    return { installed, path, loaded: true, lastExitStatus: lastExitStatus ? Number(lastExitStatus) : undefined };
  } catch {
    return { installed, path, loaded: false };
  }
}

function usage(): string {
  return "Usage: ctxd backup schedule <install|uninstall|status>";
}

export function run(argv: string[], configTime: string, configPath?: string, dataDir?: string): number {
  const [sub] = argv;
  if (sub === "install") {
    try {
      const result = installBackupSchedule({ time: configTime, configPath, dataDir });
      console.log(`ctxd backup schedule: installed ${result.label} at ${result.path} and loaded it, running daily at ${configTime}.`);
      return 0;
    } catch (err) {
      console.error(`ctxd backup schedule: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (sub === "uninstall") {
    const result = uninstallBackupSchedule();
    console.log(result.removed ? `ctxd backup schedule: removed ${result.path}.` : `ctxd backup schedule: ${result.path} was not installed; nothing to do.`);
    return 0;
  }
  if (sub === "status") {
    const status = backupScheduleStatus();
    if (!status.installed) {
      console.log(`ctxd backup schedule: not installed (no plist at ${status.path}).`);
    } else {
      const exitText = status.lastExitStatus !== undefined ? `, last exit ${status.lastExitStatus}` : "";
      console.log(`ctxd backup schedule: installed at ${status.path}${status.loaded ? ", loaded" : ", not loaded"}${exitText}.`);
    }
    return 0;
  }
  console.error(usage());
  return 1;
}
