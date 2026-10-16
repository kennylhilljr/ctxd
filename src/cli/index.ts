#!/usr/bin/env node
/**
 * ctxd command-line entry point (SPEC section 13).
 * Scaffold: commands route to their modules as milestones land.
 */
import { parseArgs } from "node:util";

const COMMANDS: Record<string, { milestone: string; summary: string }> = {
  init: { milestone: "M1", summary: "Create config, data dir, node identity, human client" },
  server: { milestone: "M1", summary: "Run the server (used by launchd)" },
  stdio: { milestone: "M5", summary: "MCP stdio proxy for Claude Desktop" },
  hook: { milestone: "M2", summary: "Hook entry point: ctxd hook <event> --client <name>" },
  scope: { milestone: "M1", summary: "Manage scopes" },
  client: { milestone: "M1", summary: "Manage client tokens" },
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
};

function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(14)} ${c.summary}`);
  return ["Usage: ctxd <command> [options]", "", "Commands:", ...lines].join("\n");
}

function main(argv: string[]): number {
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
  if (command === "hook") {
    // Hooks must never break a session (SPEC section 9.1): exit 0 silently until M2 lands.
    parseArgs({ args: rest, allowPositionals: true, strict: false });
    return 0;
  }
  console.error(`ctxd ${command}: not implemented yet (planned for ${entry.milestone}).`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
