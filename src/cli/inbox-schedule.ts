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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { lintPlist } from "./service.js";

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

function ctxdEntryPoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

export function inboxSchedulePlistPath(label: string = INBOX_SCHEDULE_LABEL, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/** launchd's StartInterval is in seconds; the config is in minutes, since "every 30 seconds" is never the right cadence for a cloud inbox. */
export function scheduleIntervalSeconds(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error(`invalid inbox schedule interval "${minutes}"; expected whole minutes, 1 to 1440`);
  }
  return minutes * 60;
}

export function inboxSchedulePlist(opts: InboxSchedulePlistOptions): string {
  const label = opts.label ?? INBOX_SCHEDULE_LABEL;
  const nodeBin = opts.nodeBin ?? process.execPath;
  const entryPoint = opts.entryPoint ?? ctxdEntryPoint();
  const home = opts.home ?? homedir();
  const interval = scheduleIntervalSeconds(opts.minutes);
  const args = [nodeBin, entryPoint, "inbox", "pull"];
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
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>StandardOutPath</key>
  <string>${home}/Library/Logs/ctxd/inbox-pull.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/Library/Logs/ctxd/inbox-pull.err.log</string>
</dict>
</plist>
`;
}

export interface InboxScheduleInstallResult {
  path: string;
  label: string;
}

/** Writes and lints the plist, creates the log directory, then loads it with `launchctl load`. Idempotent, same as `installService`. */
export function installInboxSchedule(opts: InboxSchedulePlistOptions & { path?: string }): InboxScheduleInstallResult {
  const label = opts.label ?? INBOX_SCHEDULE_LABEL;
  const path = opts.path ?? inboxSchedulePlistPath(label, opts.home);
  const home = opts.home ?? homedir();
  mkdirSync(join(home, "Library", "Logs", "ctxd"), { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, inboxSchedulePlist(opts));
  lintPlist(path);
  execFileSync("launchctl", ["load", path]);
  return { path, label };
}

export interface InboxScheduleUninstallResult {
  removed: boolean;
  path: string;
}

export function uninstallInboxSchedule(opts: { label?: string; path?: string; home?: string } = {}): InboxScheduleUninstallResult {
  const label = opts.label ?? INBOX_SCHEDULE_LABEL;
  const path = opts.path ?? inboxSchedulePlistPath(label, opts.home);
  if (!existsSync(path)) return { removed: false, path };
  try {
    execFileSync("launchctl", ["unload", path]);
  } catch {
    // Already not loaded: still remove the file.
  }
  unlinkSync(path);
  return { removed: true, path };
}

export interface InboxScheduleStatus {
  installed: boolean;
  path: string;
  loaded: boolean;
  lastExitStatus?: number;
}

/** Parses `launchctl list <label>`'s simple key/value block; absent entirely (not loaded) is reported, not thrown. An interval job has no PID between runs, so unlike `serviceStatus` this never reports one. */
export function inboxScheduleStatus(opts: { label?: string; path?: string; home?: string } = {}): InboxScheduleStatus {
  const label = opts.label ?? INBOX_SCHEDULE_LABEL;
  const path = opts.path ?? inboxSchedulePlistPath(label, opts.home);
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
