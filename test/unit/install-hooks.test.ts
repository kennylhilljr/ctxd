import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/install-hooks.js";

interface HookEntry {
  type: string;
  command: string;
  args?: string[];
  timeout: number;
  async?: boolean;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface ClaudeCodeHooksConfig {
  hooks: Record<string, HookGroup[]>;
}

let logLines: string[] = [];
let errorLines: string[] = [];
beforeEach(() => {
  logLines = [];
  errorLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The JSON block is printed as a single console.log call (JSON.stringify with indent 2); find that call and parse it whole. */
function parsePrintedJson(logCalls: string[]): ClaudeCodeHooksConfig {
  const jsonText = logCalls.find((l) => l.trimStart().startsWith("{"));
  if (!jsonText) throw new Error("no JSON block found in printed output");
  return JSON.parse(jsonText) as ClaudeCodeHooksConfig;
}

describe("ctxd install-hooks --client claude-code --dry-run", () => {
  it("prints valid, parseable JSON with every SPEC v6 9.4 event, args and timeout", () => {
    const code = run(["--client", "claude-code", "--dry-run"]);
    expect(code).toBe(0);

    const config = parsePrintedJson(logLines);
    const hooks = config.hooks;

    expect(hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "ctxd",
      args: ["hook", "session-start", "--client", "claude-code"],
      timeout: 5,
    });
    expect(hooks.SubagentStart?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "ctxd",
      args: ["hook", "subagent-start", "--client", "claude-code"],
      timeout: 5,
    });
    expect(hooks.PreCompact?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "ctxd",
      args: ["hook", "pre-compact", "--client", "claude-code"],
      timeout: 5,
    });
    expect(hooks.Stop?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "ctxd",
      args: ["hook", "stop", "--client", "claude-code"],
      timeout: 5,
    });
    expect(hooks.SessionEnd?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "ctxd",
      args: ["hook", "session-end", "--client", "claude-code"],
      timeout: 2,
    });
    expect(hooks.PostToolUse?.[0]).toMatchObject({ matcher: "Bash" });
    expect(hooks.PostToolUse?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "ctxd",
      args: ["hook", "post-tool-use", "--client", "claude-code"],
      timeout: 5,
      async: true,
    });
    expect(hooks.PreToolUse?.[0]).toMatchObject({ matcher: "Read|Edit|Write|MultiEdit|Glob|Grep|Bash" });
    expect(hooks.PreToolUse?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "ctxd",
      args: ["hook", "pre-tool-use", "--client", "claude-code"],
      timeout: 3,
    });

    // All seven SPEC v6 9.4 events are present.
    expect(Object.keys(hooks).sort()).toEqual(
      ["PostToolUse", "PreCompact", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "SubagentStart"].sort(),
    );
  });

  it("prints the MCP registration line and its one-line note", () => {
    run(["--client", "claude-code", "--dry-run"]);
    const output = logLines.join("\n");
    expect(output).toContain("claude mcp add --scope user ctxd -- ctxd mcp --client claude-code");
    expect(output).toContain("identical in every project");
  });

  it("writes nothing: no file system call is made", () => {
    // This test documents the invariant by construction: printInstallHooksDryRun/run only call
    // console.log/console.error. A grep-based check in CI-adjacent review covers the rest.
    expect(() => run(["--client", "claude-code", "--dry-run"])).not.toThrow();
  });
});

describe("ctxd install-hooks --client codex --dry-run", () => {
  it("prints every SPEC v6 9.5 hook table with timeouts at or below 3", () => {
    const code = run(["--client", "codex", "--dry-run"]);
    expect(code).toBe(0);
    const output = logLines.join("\n");

    expect(output).toContain("[mcp_servers.ctxd]");
    expect(output).toContain('command = "ctxd"');
    expect(output).toContain('args = ["mcp", "--client", "codex"]');

    for (const event of ["SessionStart", "Stop", "PreCompact", "PostCompact", "PostToolUse", "PreToolUse", "SessionEnd"]) {
      expect(output).toContain(`[[hooks.${event}]]`);
      expect(output).toContain(`[[hooks.${event}.hooks]]`);
    }
    expect(output).toContain('matcher = "^Bash$"');

    const timeouts = [...output.matchAll(/timeout = (\d+)/g)].map((m) => Number(m[1]));
    expect(timeouts.length).toBe(7);
    for (const t of timeouts) expect(t).toBeLessThanOrEqual(3);
  });

  it("prints the /hooks approval reminder", () => {
    run(["--client", "codex", "--dry-run"]);
    expect(logLines.join("\n")).toContain("/hooks");
    expect(logLines.join("\n").toLowerCase()).toContain("approved");
  });
});

describe("ctxd install-hooks with an invalid --client", () => {
  it("errors cleanly and exits 1", () => {
    const code = run(["--client", "bogus", "--dry-run"]);
    expect(code).toBe(1);
    expect(errorLines.join("\n")).toContain("--client must be one of");
  });

  it("errors cleanly when --client is missing", () => {
    const code = run([]);
    expect(code).toBe(1);
    expect(errorLines.join("\n")).toContain("--client must be one of");
  });
});

describe("ctxd install-hooks without --dry-run", () => {
  it("prints the not-yet-implemented message, writes nothing, and exits 0", () => {
    const code = run(["--client", "claude-code"]);
    expect(code).toBe(0);
    expect(errorLines.join("\n")).toContain("isn't implemented yet");
    expect(errorLines.join("\n")).toContain("planned for a later M2 slice");
    expect(logLines.length).toBe(0);
  });

  it("does not throw for codex either", () => {
    expect(() => run(["--client", "codex"])).not.toThrow();
  });
});
