/**
 * `ctxd install-hooks --client <claude-code|codex> [--dry-run|--uninstall]` (SPEC v6 sections
 * 9.4, 9.5, 13): writes or removes ctxd's own hook and MCP registration in the client's real
 * config file, merging around whatever else is already there.
 *
 * Claude Code (`~/.claude/settings.json`, JSON): only ctxd's own hook *groups* are touched,
 * identified by `command === "ctxd"`. Every other tool's groups for the same event, and every
 * other top-level settings key, are carried through untouched. MCP registration for Claude Code
 * is a separate mechanism (`claude mcp add`, a different store this file never touches); the
 * command is printed as an instruction, same as in `--dry-run`.
 *
 * Codex (`~/.codex/config.toml`, TOML, also where its MCP registration lives): no TOML parser is
 * used for the write, since round-tripping through one risks reformatting or dropping comments
 * elsewhere in the file. Instead ctxd's whole block (MCP registration plus every hook table) is
 * wrapped in two marker comment lines; install replaces the text between them (or appends a new
 * marked block if absent), and uninstall removes exactly that span. Everything outside the
 * markers is never read as structured data, only carried through as literal text.
 *
 * Both paths: back up the existing file before any real change, atomically (temp file, then
 * rename), and are idempotent: recomputing the same desired state twice produces byte-identical
 * output, so a second run detects no change and skips the write and the backup.
 */
import { parseArgs } from "node:util";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const INSTALL_HOOKS_CLIENTS = ["claude-code", "codex"] as const;
export type InstallHooksClient = (typeof INSTALL_HOOKS_CLIENTS)[number];

/** The exact `hooks` block for Claude Code's `.claude/settings.json` (SPEC v6 section 9.4). */
export function claudeCodeHooksConfig(): object {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "ctxd", args: ["hook", "session-start", "--client", "claude-code"], timeout: 5 }] }],
      SubagentStart: [{ hooks: [{ type: "command", command: "ctxd", args: ["hook", "subagent-start", "--client", "claude-code"], timeout: 5 }] }],
      PreCompact: [{ hooks: [{ type: "command", command: "ctxd", args: ["hook", "pre-compact", "--client", "claude-code"], timeout: 5 }] }],
      Stop: [{ hooks: [{ type: "command", command: "ctxd", args: ["hook", "stop", "--client", "claude-code"], timeout: 5 }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "ctxd", args: ["hook", "session-end", "--client", "claude-code"], timeout: 2 }] }],
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "ctxd", args: ["hook", "post-tool-use", "--client", "claude-code"], timeout: 5, async: true }],
        },
      ],
      PreToolUse: [
        {
          matcher: "Read|Edit|Write|MultiEdit|Glob|Grep|Bash",
          hooks: [{ type: "command", command: "ctxd", args: ["hook", "pre-tool-use", "--client", "claude-code"], timeout: 3 }],
        },
      ],
    },
  };
}

/** The MCP registration command Claude Code uses; identical in every project (SPEC v6 section 9.4). */
export const CLAUDE_CODE_MCP_ADD_COMMAND = "claude mcp add --scope user ctxd -- ctxd mcp --client claude-code";

/** The exact `~/.codex/config.toml` block (SPEC v6 section 9.5): MCP registration plus every hook table, each clamped to Codex's 3-second max timeout. */
export function codexConfigToml(): string {
  return `[mcp_servers.ctxd]
command = "ctxd"
args = ["mcp", "--client", "codex"]

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "ctxd hook session-start --client codex"
timeout = 3

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "ctxd hook stop --client codex"
timeout = 3

[[hooks.PreCompact]]
[[hooks.PreCompact.hooks]]
type = "command"
command = "ctxd hook pre-compact --client codex"
timeout = 3

[[hooks.PostCompact]]
[[hooks.PostCompact.hooks]]
type = "command"
command = "ctxd hook post-compact --client codex"
timeout = 3

[[hooks.PostToolUse]]
matcher = "^Bash$"
[[hooks.PostToolUse.hooks]]
type = "command"
command = "ctxd hook post-tool-use --client codex"
timeout = 3

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "ctxd hook pre-tool-use --client codex"
timeout = 3

[[hooks.SessionEnd]]
[[hooks.SessionEnd.hooks]]
type = "command"
command = "ctxd hook session-end --client codex"
timeout = 3
`;
}

/** Reminder printed with the Codex dry-run output; operationally important since Codex will not run a hook it hasn't seen approved. */
export const CODEX_HOOKS_APPROVAL_NOTE = "Reminder: new or changed hooks must be approved once in Codex's /hooks browser before they run.";

/** Note printed with the Claude Code dry-run output. */
export const CLAUDE_CODE_MCP_NOTE = "This is the only MCP entry ctxd needs; it is identical in every project and names no scope or pool.";

/** Prints, to stdout, exactly what `ctxd install-hooks --client <id> --dry-run` would write. Writes nothing. */
export function printInstallHooksDryRun(client: InstallHooksClient): void {
  if (client === "claude-code") {
    console.log("# .claude/settings.json: hooks (dry run, nothing written)");
    console.log(JSON.stringify(claudeCodeHooksConfig(), null, 2));
    console.log("");
    console.log("# MCP registration (dry run, nothing written):");
    console.log(CLAUDE_CODE_MCP_ADD_COMMAND);
    console.log("");
    console.log(CLAUDE_CODE_MCP_NOTE);
    return;
  }
  console.log("# ~/.codex/config.toml (dry run, nothing written):");
  console.log(codexConfigToml());
  console.log(CODEX_HOOKS_APPROVAL_NOTE);
}

// ---------------------------------------------------------------------------
// Real write: shared file helpers
// ---------------------------------------------------------------------------

export function claudeCodeSettingsPath(home: string = homedir()): string {
  return join(home, ".claude", "settings.json");
}

export function codexConfigPath(home: string = homedir()): string {
  return join(home, ".codex", "config.toml");
}

export interface WriteOutcome {
  changed: boolean;
  path: string;
  backupPath: string | null;
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Atomic write (temp file in the same directory, then rename over the target); preserves the target's existing file mode, if it had one. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const priorMode = existsSync(path) ? statSync(path).mode : undefined;
  const tmp = `${path}.ctxd-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  if (priorMode !== undefined) chmodSync(path, priorMode);
}

/** Copies `path` to a timestamped backup alongside it, preserving its mode. Only called when a real change is about to be written. */
function backupFile(path: string): string {
  const backupPath = `${path}.ctxd-backup-${timestampSuffix()}`;
  writeFileSync(backupPath, readFileSync(path));
  chmodSync(backupPath, statSync(path).mode);
  return backupPath;
}

// ---------------------------------------------------------------------------
// Claude Code: merge into settings.json's "hooks" object
// ---------------------------------------------------------------------------

interface ClaudeHookEntry {
  type: string;
  command: string;
  args?: string[];
  timeout: number;
  async?: boolean;
}
interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}
type ClaudeHooksByEvent = Record<string, ClaudeHookGroup[]>;

function isCtxdGroup(group: ClaudeHookGroup): boolean {
  return Array.isArray(group.hooks) && group.hooks.some((h) => h.command === "ctxd");
}

/** Every event's array, with ctxd's own groups removed and every other group kept in place. */
function withoutCtxdGroups(hooks: ClaudeHooksByEvent): ClaudeHooksByEvent {
  const out: ClaudeHooksByEvent = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = (groups ?? []).filter((g) => !isCtxdGroup(g));
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

/** `withoutCtxdGroups`, then ctxd's desired groups appended to each event they belong to. */
function withCtxdGroups(hooks: ClaudeHooksByEvent, desired: ClaudeHooksByEvent): ClaudeHooksByEvent {
  const base = withoutCtxdGroups(hooks);
  const out: ClaudeHooksByEvent = { ...base };
  for (const [event, groups] of Object.entries(desired)) {
    out[event] = [...(base[event] ?? []), ...groups];
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  return aKeys.length === bKeys.length && aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} does not contain a JSON object`);
  return parsed as Record<string, unknown>;
}

function writeClaudeCodeSettings(path: string, transform: (hooks: ClaudeHooksByEvent) => ClaudeHooksByEvent): WriteOutcome {
  let settings: Record<string, unknown>;
  try {
    settings = readJsonObject(path);
  } catch (err) {
    throw new Error(`${path} is not valid JSON; refusing to touch it (${(err as Error).message}).`);
  }
  const existingHooks = (typeof settings.hooks === "object" && settings.hooks !== null && !Array.isArray(settings.hooks) ? settings.hooks : {}) as ClaudeHooksByEvent;
  const nextHooks = transform(existingHooks);
  if (deepEqual(existingHooks, nextHooks)) return { changed: false, path, backupPath: null };

  const nextSettings: Record<string, unknown> = { ...settings };
  // An empty `hooks: {}` is functionally identical to no `hooks` key at all, so uninstalling
  // ctxd's last hook group drops the key entirely rather than leaving an empty one behind.
  if (Object.keys(nextHooks).length > 0) nextSettings.hooks = nextHooks;
  else delete nextSettings.hooks;

  const backupPath = existsSync(path) ? backupFile(path) : null;
  atomicWrite(path, `${JSON.stringify(nextSettings, null, 2)}\n`);
  return { changed: true, path, backupPath };
}

export function installClaudeCodeHooks(path: string = claudeCodeSettingsPath()): WriteOutcome {
  const desired = (claudeCodeHooksConfig() as { hooks: ClaudeHooksByEvent }).hooks;
  return writeClaudeCodeSettings(path, (hooks) => withCtxdGroups(hooks, desired));
}

export function uninstallClaudeCodeHooks(path: string = claudeCodeSettingsPath()): WriteOutcome {
  return writeClaudeCodeSettings(path, (hooks) => withoutCtxdGroups(hooks));
}

// ---------------------------------------------------------------------------
// Codex: a single marked, replaceable block in config.toml
// ---------------------------------------------------------------------------

const CTXD_BLOCK_START = "# >>> ctxd managed block (added by `ctxd install-hooks --client codex`) >>>";
const CTXD_BLOCK_END = "# <<< ctxd managed block (remove with `ctxd install-hooks --client codex --uninstall`) <<<";

function ctxdBlockText(): string {
  return `${CTXD_BLOCK_START}\n${codexConfigToml()}${CTXD_BLOCK_END}\n`;
}

/** Locates ctxd's marked block, if present. Throws rather than guessing if a start marker has no matching end marker. */
function splitOnMarkers(text: string): { before: string; after: string } | null {
  const startIdx = text.indexOf(CTXD_BLOCK_START);
  if (startIdx < 0) return null;
  const endMarkerIdx = text.indexOf(CTXD_BLOCK_END, startIdx);
  if (endMarkerIdx < 0) throw new Error("found ctxd's start marker without its matching end marker; refusing to touch this file.");
  let afterIdx = endMarkerIdx + CTXD_BLOCK_END.length;
  if (text[afterIdx] === "\n") afterIdx += 1; // the block's own trailing newline belongs to the block, not to "after"
  return { before: text.slice(0, startIdx), after: text.slice(afterIdx) };
}

function writeCodexConfig(path: string, transform: (existingText: string) => string): WriteOutcome {
  const existingText = existsSync(path) ? readFileSync(path, "utf8") : "";
  const nextText = transform(existingText);
  if (nextText === existingText) return { changed: false, path, backupPath: null };
  const backupPath = existsSync(path) ? backupFile(path) : null;
  atomicWrite(path, nextText);
  return { changed: true, path, backupPath };
}

/**
 * Install's separator between existing content and ctxd's block is always normalized to exactly
 * one blank line (trailing newlines on the existing content are trimmed first, then exactly
 * "\n\n" is inserted). Uninstall reverses this precisely. The one known, documented edge case:
 * a file with *no* trailing newline at all gains one permanently after an install/uninstall
 * round trip; every other case, including the common "exactly one trailing newline," restores
 * byte for byte.
 */
export function installCodexHooks(path: string = codexConfigPath()): WriteOutcome {
  return writeCodexConfig(path, (existingText) => {
    const split = splitOnMarkers(existingText);
    const block = ctxdBlockText();
    if (split) return `${split.before}${block}${split.after}`;
    const trimmed = existingText.replace(/\n+$/, "");
    const prefix = trimmed === "" ? "" : `${trimmed}\n\n`;
    return `${prefix}${block}`;
  });
}

export function uninstallCodexHooks(path: string = codexConfigPath()): WriteOutcome {
  return writeCodexConfig(path, (existingText) => {
    const split = splitOnMarkers(existingText);
    if (!split) return existingText;
    const before = split.before.endsWith("\n\n") ? split.before.slice(0, -1) : split.before;
    return `${before}${split.after}`;
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function reportOutcome(client: InstallHooksClient, uninstall: boolean, outcome: WriteOutcome): void {
  if (!outcome.changed) {
    console.log(`ctxd install-hooks: ${outcome.path} ${uninstall ? "has no ctxd hooks" : "already has ctxd's hooks"}; nothing to do.`);
    return;
  }
  console.log(`ctxd install-hooks: ${uninstall ? "removed ctxd's hooks from" : "installed ctxd's hooks into"} ${outcome.path}.`);
  if (outcome.backupPath) console.log(`ctxd install-hooks: backed up the original to ${outcome.backupPath}.`);
  if (uninstall) return;
  console.log("");
  if (client === "claude-code") {
    console.log("Also register the MCP server (one-time, identical in every project):");
    console.log(`  ${CLAUDE_CODE_MCP_ADD_COMMAND}`);
  } else {
    console.log(CODEX_HOOKS_APPROVAL_NOTE);
  }
}

function usage(): string {
  return `Usage: ctxd install-hooks --client <${INSTALL_HOOKS_CLIENTS.join("|")}> [--dry-run|--uninstall]`;
}

export function run(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { client: { type: "string" }, "dry-run": { type: "boolean" }, uninstall: { type: "boolean" } },
    strict: true,
  });

  const client = values.client;
  if (!client || !INSTALL_HOOKS_CLIENTS.includes(client as InstallHooksClient)) {
    console.error(`ctxd install-hooks: --client must be one of: ${INSTALL_HOOKS_CLIENTS.join(", ")}.`);
    console.error(usage());
    return 1;
  }
  if (values["dry-run"] && values.uninstall) {
    console.error("ctxd install-hooks: --dry-run and --uninstall cannot be combined.");
    return 1;
  }

  if (values["dry-run"]) {
    printInstallHooksDryRun(client as InstallHooksClient);
    return 0;
  }

  try {
    const outcome =
      client === "claude-code"
        ? values.uninstall
          ? uninstallClaudeCodeHooks()
          : installClaudeCodeHooks()
        : values.uninstall
          ? uninstallCodexHooks()
          : installCodexHooks();
    reportOutcome(client as InstallHooksClient, values.uninstall === true, outcome);
    return 0;
  } catch (err) {
    console.error(`ctxd install-hooks: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
