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
import { homedir } from "node:os";
import { agentPlistPath, agentStatus, buildAgentPlist, installAgent, uninstallAgent } from "./launchd.js";

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

export function backupSchedulePlistPath(label: string = BACKUP_SCHEDULE_LABEL, home: string = homedir()): string {
  return agentPlistPath(label, home);
}

/** Parses the config-validated "HH:MM" into launchd's StartCalendarInterval Hour/Minute integers. */
export function parseScheduleTime(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`invalid backup schedule time "${time}"; expected HH:MM`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function backupSchedulePlist(opts: BackupSchedulePlistOptions): string {
  const { hour, minute } = parseScheduleTime(opts.time);
  return buildAgentPlist({
    label: opts.label ?? BACKUP_SCHEDULE_LABEL,
    command: ["backup"],
    logName: "backup",
    schedule: { kind: "calendar", hour, minute },
    ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
    ...(opts.entryPoint ? { entryPoint: opts.entryPoint } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
  });
}

export interface BackupScheduleInstallResult {
  path: string;
  label: string;
}

/** Writes and lints the plist, creates the log directory, then reloads the agent so a reinstall really applies (src/cli/launchd.ts's `installAgent`). */
export function installBackupSchedule(opts: BackupSchedulePlistOptions & { path?: string }): BackupScheduleInstallResult {
  const { hour, minute } = parseScheduleTime(opts.time);
  return installAgent({
    label: opts.label ?? BACKUP_SCHEDULE_LABEL,
    command: ["backup"],
    logName: "backup",
    schedule: { kind: "calendar", hour, minute },
    ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
    ...(opts.entryPoint ? { entryPoint: opts.entryPoint } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    ...(opts.path ? { path: opts.path } : {}),
  });
}

export interface BackupScheduleUninstallResult {
  removed: boolean;
  path: string;
}

export function uninstallBackupSchedule(opts: { label?: string; path?: string; home?: string } = {}): BackupScheduleUninstallResult {
  return uninstallAgent({
    label: opts.label ?? BACKUP_SCHEDULE_LABEL,
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });
}

export interface BackupScheduleStatus {
  installed: boolean;
  path: string;
  loaded: boolean;
  lastExitStatus?: number;
}

/** Parses `launchctl list <label>`'s simple key/value block; absent entirely (not loaded) is reported, not thrown. A scheduled job has no PID between runs, so unlike `serviceStatus` this never reports one. */
export function backupScheduleStatus(opts: { label?: string; path?: string; home?: string } = {}): BackupScheduleStatus {
  return agentStatus({
    label: opts.label ?? BACKUP_SCHEDULE_LABEL,
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });
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
