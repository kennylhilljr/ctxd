/**
 * `ctxd install-hooks --client <claude-code|codex> [--dry-run]` (SPEC v6 sections 9.4, 9.5, 13).
 *
 * This slice builds only the `--dry-run` path: it prints the exact hook and MCP configuration
 * ctxd would write, and writes nothing. The real-write path (editing `~/.claude/settings.json`
 * or `~/.codex/config.toml` in place, with confirmation and a backup of existing files) is a
 * later M2 slice; this file must never call `fs.writeFileSync` or otherwise touch a real path.
 */
import { parseArgs } from "node:util";

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

/** Printed when `--dry-run` is omitted: the real-write path isn't built in this slice, and this command must never write to a real config file. */
export function printRealWriteNotImplemented(): void {
  console.error(
    "ctxd install-hooks: writing config directly isn't implemented yet (planned for a later M2 slice: confirmation plus a backup of " +
      "existing files). Nothing was written. Use --dry-run to print the exact hook and MCP configuration to copy in by hand.",
  );
}

function usage(): string {
  return `Usage: ctxd install-hooks --client <${INSTALL_HOOKS_CLIENTS.join("|")}> [--dry-run]`;
}

export function run(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { client: { type: "string" }, "dry-run": { type: "boolean" } },
    strict: true,
  });

  const client = values.client;
  if (!client || !INSTALL_HOOKS_CLIENTS.includes(client as InstallHooksClient)) {
    console.error(`ctxd install-hooks: --client must be one of: ${INSTALL_HOOKS_CLIENTS.join(", ")}.`);
    console.error(usage());
    return 1;
  }

  if (!values["dry-run"]) {
    printRealWriteNotImplemented();
    return 0;
  }

  printInstallHooksDryRun(client as InstallHooksClient);
  return 0;
}
