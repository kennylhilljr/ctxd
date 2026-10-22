/**
 * `ctxd inbox schedule install|uninstall|status`: a launchd agent that runs `ctxd inbox pull`
 * unattended, every `[inbox] schedule_minutes` (default 15). The W1 handoff and
 * docs/build/M7-deploy-runbook-v1.md both named this as the follow-up that makes the mobile inbox
 * usable without running it by hand; W7's plan listed it, and the owner approved it.
 *
 * Deliberately shaped like `src/cli/backup-schedule.ts` (W4), down to the function names: the two
 * differ only in what they launch and in how launchd is told when to run it (`StartInterval` here,
 * since inbox capture wants "every few minutes"; `StartCalendarInterval` there, since a backup
 * wants "once a day at 03:15"). Both now exist, which is the second instance W7's plan said was
 * needed before generalizing; extracting one shared plist helper is listed there, unbuilt, and is
 * deliberately not done in this change. Only `lintPlist` is shared today.
 *
 * Safe with the flag off: `ctxd inbox pull` itself reports `mobile_inbox` off and exits 0 without
 * a single network call, so a loaded job on a machine with the flag off does nothing at all.
 *
 * Tests always pass an explicit `path`, `label` and `home`, so they install and load a real but
 * harmless, scratch-pathed, test-labeled job and tear it down in the same run; they never touch
 * `~/Library/LaunchAgents/dev.ctxd.inbox-pull.plist` or pull a real inbox.
 */
import { homedir } from "node:os";
import { agentPlistPath, agentStatus, buildAgentPlist, installAgent, uninstallAgent } from "./launchd.js";

export const INBOX_SCHEDULE_LABEL = "dev.ctxd.inbox-pull";

export interface InboxSchedulePlistOptions {
  label?: string;
  nodeBin?: string;
  entryPoint?: string;
  home?: string;
  /** Minutes between runs, matching `config.inbox.schedule_minutes`'s own validation. */
  minutes: number;
  configPath?: string;
  dataDir?: string;
}

export function inboxSchedulePlistPath(label: string = INBOX_SCHEDULE_LABEL, home: string = homedir()): string {
  return agentPlistPath(label, home);
}

/** launchd's StartInterval is in seconds; the config is in minutes, since "every 30 seconds" is never the right cadence for a cloud inbox. */
export function scheduleIntervalSeconds(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error(`invalid inbox schedule interval "${minutes}"; expected whole minutes, 1 to 1440`);
  }
  return minutes * 60;
}

export function inboxSchedulePlist(opts: InboxSchedulePlistOptions): string {
  return buildAgentPlist({
    label: opts.label ?? INBOX_SCHEDULE_LABEL,
    command: ["inbox", "pull"],
    logName: "inbox-pull",
    schedule: { kind: "interval", seconds: scheduleIntervalSeconds(opts.minutes) },
    ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
    ...(opts.entryPoint ? { entryPoint: opts.entryPoint } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
  });
}

export interface InboxScheduleInstallResult {
  path: string;
  label: string;
}

/** Writes and lints the plist, creates the log directory, then reloads the agent so a reinstall really applies the new interval (src/cli/launchd.ts's `installAgent`). */
export function installInboxSchedule(opts: InboxSchedulePlistOptions & { path?: string }): InboxScheduleInstallResult {
  return installAgent({
    label: opts.label ?? INBOX_SCHEDULE_LABEL,
    command: ["inbox", "pull"],
    logName: "inbox-pull",
    schedule: { kind: "interval", seconds: scheduleIntervalSeconds(opts.minutes) },
    ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
    ...(opts.entryPoint ? { entryPoint: opts.entryPoint } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    ...(opts.path ? { path: opts.path } : {}),
  });
}

export interface InboxScheduleUninstallResult {
  removed: boolean;
  path: string;
}

export function uninstallInboxSchedule(opts: { label?: string; path?: string; home?: string } = {}): InboxScheduleUninstallResult {
  return uninstallAgent({
    label: opts.label ?? INBOX_SCHEDULE_LABEL,
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });
}

export interface InboxScheduleStatus {
  installed: boolean;
  path: string;
  loaded: boolean;
  lastExitStatus?: number;
}

/** Parses `launchctl list <label>`'s simple key/value block; absent entirely (not loaded) is reported, not thrown. An interval job has no PID between runs, so unlike `serviceStatus` this never reports one. */
export function inboxScheduleStatus(opts: { label?: string; path?: string; home?: string } = {}): InboxScheduleStatus {
  return agentStatus({
    label: opts.label ?? INBOX_SCHEDULE_LABEL,
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });
}

function usage(): string {
  return "Usage: ctxd inbox schedule <install|uninstall|status>";
}

export function run(argv: string[], configMinutes: number, configPath?: string, dataDir?: string): number {
  const [sub] = argv;
  if (sub === "install") {
    try {
      const result = installInboxSchedule({ minutes: configMinutes, configPath, dataDir });
      console.log(`ctxd inbox schedule: installed ${result.label} at ${result.path} and loaded it, running every ${configMinutes} minute(s).`);
      return 0;
    } catch (err) {
      console.error(`ctxd inbox schedule: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (sub === "uninstall") {
    const result = uninstallInboxSchedule();
    console.log(result.removed ? `ctxd inbox schedule: removed ${result.path}.` : `ctxd inbox schedule: ${result.path} was not installed; nothing to do.`);
    return 0;
  }
  if (sub === "status") {
    const status = inboxScheduleStatus();
    if (!status.installed) {
      console.log(`ctxd inbox schedule: not installed (no plist at ${status.path}).`);
    } else {
      const exitText = status.lastExitStatus !== undefined ? `, last exit ${status.lastExitStatus}` : "";
      console.log(`ctxd inbox schedule: installed at ${status.path}${status.loaded ? ", loaded" : ", not loaded"}${exitText}.`);
    }
    return 0;
  }
  console.error(usage());
  return 1;
}
