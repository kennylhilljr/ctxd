#!/usr/bin/env node
/**
 * ctxd command-line entry point (SPEC v6 section 13).
 * Scaffold: commands route to their modules as milestones land.
 */
import { parseArgs } from "node:util";
import { run as runInitCommand } from "./init.js";
import { run as runRebuildCommand } from "./rebuild.js";
import { run as runClientCommand } from "./client.js";
import { run as runScopeCommand } from "./scope.js";
import { run as runPoolCommand } from "./pool.js";
import { run as runGrantCommand } from "./grant.js";
import { run as runAccessCommand } from "./access.js";
import { run as runPersonaCommand } from "./persona.js";
import { run as runServerCommand } from "./server.js";
import { run as runMcpCommand } from "./mcp.js";
import { run as runFlagCommand } from "./flag.js";
import { run as runPurgeCommand } from "./purge.js";
import { run as runQuarantineCommand } from "./quarantine.js";
import { run as runBatchCommand } from "./batch.js";
import { run as runBriefCommand } from "./brief.js";
import { run as runHistoryCommand } from "./history.js";
import { run as runShowCommand } from "./show.js";
import { run as runStatsCommand } from "./stats.js";
import { run as runLsCommand } from "./ls.js";
import { run as runTreeCommand } from "./tree.js";
import { run as runReadCommand } from "./read.js";

/** Each command's parsed-args entry point, added as its milestone lands. */
const COMMAND_RUNNERS: Record<string, (argv: string[]) => number | Promise<number>> = {
  hook: (argv) => {
    // Hooks must never break a session (SPEC section 9.1): exit 0 silently until M2 lands.
    parseArgs({ args: argv, allowPositionals: true, strict: false });
    return 0;
  },
  init: runInitCommand,
  rebuild: runRebuildCommand,
  client: runClientCommand,
  scope: runScopeCommand,
  pool: runPoolCommand,
  grant: runGrantCommand,
  access: runAccessCommand,
  persona: runPersonaCommand,
  server: runServerCommand,
  mcp: runMcpCommand,
  flag: runFlagCommand,
  purge: runPurgeCommand,
  quarantine: runQuarantineCommand,
  batch: runBatchCommand,
  brief: runBriefCommand,
  history: runHistoryCommand,
  show: runShowCommand,
  stats: runStatsCommand,
  ls: runLsCommand,
  tree: runTreeCommand,
  read: runReadCommand,
};

const COMMANDS: Record<string, { milestone: string; summary: string }> = {
  init: { milestone: "M1", summary: "Create config, data dir, node identity, human client" },
  server: { milestone: "M1", summary: "Run the server (used by launchd)" },
  stdio: { milestone: "M5", summary: "MCP stdio proxy for Claude Desktop" },
  hook: { milestone: "M2", summary: "Hook entry point: ctxd hook <event> --client <name>" },
  scope: { milestone: "M1", summary: "Manage scopes" },
  client: { milestone: "M1", summary: "Manage client tokens" },
  grant: { milestone: "M1", summary: "Temporary grant: ctxd grant <client> <scope> --level <l> --for <duration>" },
  access: { milestone: "M1", summary: "Effective access per scope and the reason for each" },
  node: { milestone: "M3", summary: "Manage peers" },
  sync: { milestone: "M3", summary: "Pull from peers now" },
  brief: { milestone: "M1", summary: "Print a brief for a scope" },
  review: { milestone: "M2", summary: "Review proposed, conflicted and auto-resolved entries" },
  export: { milestone: "M6", summary: "Export scopes as Markdown" },
  backup: { milestone: "M4", summary: "Encrypted backup" },
  restore: { milestone: "M4", summary: "Restore from backup" },
  rebuild: { milestone: "M1", summary: "Rebuild state and FTS from the event log" },
  doctor: { milestone: "M4", summary: "Diagnostics" },
  "install-hooks": { milestone: "M2", summary: "Write hook and MCP config for a client" },
  claims: { milestone: "M2", summary: "List claims with state, paths, overlaps and drift" },
  history: { milestone: "M1", summary: "Show every change to an entry" },
  show: { milestone: "M1", summary: "Show an entry, optionally as of a time" },
  status: { milestone: "M4", summary: "Health, scope, claims and sync" },
  statusline: { milestone: "M4", summary: "One-line status for the Claude Code status line" },
  worker: { milestone: "M2", summary: "Internal: detached hook work" },
  mcp: { milestone: "M1", summary: "Stdio MCP launcher: picks the persona, proxies with its token" },
  persona: { milestone: "M1", summary: "Issue, rotate, revoke or prefer persona tokens" },
  pool: { milestone: "M1", summary: "Persona pools: create, grant, members, seal, enroll, lock" },
  flag: { milestone: "M1", summary: "Flag or unflag an entry" },
  quarantine: { milestone: "M2", summary: "Quarantine a source's writes; then revert or release" },
  batch: { milestone: "M2", summary: "Show, revert or release a quarantine batch" },
  purge: { milestone: "M1", summary: "Erase an entry's content everywhere" },
  tidy: { milestone: "M5", summary: "Interactive cleanup suggestions" },
  ls: { milestone: "M2", summary: "List a ctxd:// folder with summary lines" },
  tree: { milestone: "M2", summary: "Show the ctxd:// tree to a depth" },
  read: { milestone: "M2", summary: "Print an entry, or a folder's overview" },
  grep: { milestone: "M2", summary: "Full-text search within a subtree" },
  open: { milestone: "M6", summary: "Open an entry's mirror file in $EDITOR" },
  mirror: { milestone: "M6", summary: "Start, stop or check the Markdown mirror" },
  import: { milestone: "M6", summary: "Import Markdown files as proposed entries" },
  skills: { milestone: "M2", summary: "List, show, sync or import skills" },
  remember: { milestone: "M2", summary: "Record a preference, convention or fact in _me" },
  log: { milestone: "M2", summary: "Add a journal entry" },
  journal: { milestone: "M2", summary: "Read the journal by day or time" },
  digest: { milestone: "M5", summary: "Print or write a weekly digest" },
  signals: { milestone: "M2", summary: "Open blockers, incidents, blocking tasks and flags" },
  stats: { milestone: "M1", summary: "Response sizes per tool and client" },
};

function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(14)} ${c.summary}`);
  return ["Usage: ctxd <command> [options]", "", "Commands:", ...lines].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return 0;
  }
  if (command === "version" || command === "--version") {
    console.log("ctxd 0.0.1");
    return 0;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`Unknown command: ${command}\n\n${usage()}`);
    return 2;
  }
  const runner = COMMAND_RUNNERS[command];
  if (runner) return await runner(rest);
  console.error(`ctxd ${command}: not implemented yet (planned for ${entry.milestone}).`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
