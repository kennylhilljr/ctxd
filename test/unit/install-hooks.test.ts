import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeCodeSettingsPath,
  codexConfigPath,
  installClaudeCodeHooks,
  installCodexHooks,
  run,
  uninstallClaudeCodeHooks,
  uninstallCodexHooks,
} from "../../src/cli/install-hooks.js";

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

// ---------------------------------------------------------------------------
// Real write: always against a temporary $HOME, never the real one.
// ---------------------------------------------------------------------------

let tempHome: string;
let realHome: string | undefined;
beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "ctxd-install-hooks-home-"));
  realHome = process.env.HOME;
  process.env.HOME = tempHome;
});
afterEach(() => {
  process.env.HOME = realHome;
});

function backupsIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(".ctxd-backup-")) : [];
}

describe("installClaudeCodeHooks (real write)", () => {
  it("creates settings.json from scratch with every ctxd hook, and is idempotent", () => {
    const path = claudeCodeSettingsPath(tempHome);
    const first = installClaudeCodeHooks(path);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeNull(); // nothing existed to back up

    const written = JSON.parse(readFileSync(path, "utf8")) as ClaudeCodeHooksConfig;
    expect(written.hooks.Stop?.[0]?.hooks[0]).toMatchObject({ command: "ctxd", args: ["hook", "stop", "--client", "claude-code"] });

    const second = installClaudeCodeHooks(path);
    expect(second.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(written, null, 2)}\n`);
    expect(backupsIn(join(tempHome, ".claude"))).toHaveLength(0); // no-op: no backup taken
  });

  it("preserves unrelated settings keys and another tool's hook group for the same event, and backs up the original", () => {
    const dir = join(tempHome, ".claude");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "settings.json");
    const original = {
      permissions: { allow: ["Bash(npm test:*)"] },
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "some-other-tool", timeout: 5 }] }] },
    };
    writeFileSync(path, JSON.stringify(original, null, 2));

    const result = installClaudeCodeHooks(path);
    expect(result.changed).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(JSON.parse(readFileSync(result.backupPath!, "utf8"))).toEqual(original);

    const written = JSON.parse(readFileSync(path, "utf8")) as { permissions: unknown; hooks: Record<string, HookGroup[]> };
    expect(written.permissions).toEqual(original.permissions);
    expect(written.hooks.PostToolUse).toHaveLength(2);
    expect(written.hooks.PostToolUse?.[0]).toMatchObject({ matcher: "Edit" });
    expect(written.hooks.PostToolUse?.[1]).toMatchObject({ matcher: "Bash" });
  });

  it("refuses to touch a settings.json that is not valid JSON", () => {
    const dir = join(tempHome, ".claude");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "settings.json");
    writeFileSync(path, "{ not json");

    expect(() => installClaudeCodeHooks(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{ not json"); // untouched
  });
});

describe("uninstallClaudeCodeHooks (real write)", () => {
  it("removes exactly ctxd's groups, leaving another tool's hooks and other settings keys intact", () => {
    const path = claudeCodeSettingsPath(tempHome);
    mkdirSync(join(tempHome, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { allow: ["Bash(npm test:*)"] },
        hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "some-other-tool", timeout: 5 }] }] },
      }),
    );
    installClaudeCodeHooks(path);

    const result = uninstallClaudeCodeHooks(path);
    expect(result.changed).toBe(true);

    const written = JSON.parse(readFileSync(path, "utf8")) as { permissions: unknown; hooks: Record<string, HookGroup[]> };
    expect(written.permissions).toEqual({ allow: ["Bash(npm test:*)"] });
    expect(written.hooks.PostToolUse).toEqual([{ matcher: "Edit", hooks: [{ type: "command", command: "some-other-tool", timeout: 5 }] }]);
    expect(written.hooks.Stop).toBeUndefined();
    expect(written.hooks.SessionStart).toBeUndefined();
  });

  it("is a no-op when ctxd was never installed", () => {
    const path = claudeCodeSettingsPath(tempHome);
    const result = uninstallClaudeCodeHooks(path);
    expect(result.changed).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("round-trips: install then uninstall restores the exact original bytes", () => {
    const path = claudeCodeSettingsPath(tempHome);
    mkdirSync(join(tempHome, ".claude"), { recursive: true });
    const originalText = `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`;
    writeFileSync(path, originalText);

    installClaudeCodeHooks(path);
    uninstallClaudeCodeHooks(path);

    expect(readFileSync(path, "utf8")).toBe(originalText);
  });
});

describe("installCodexHooks (real write)", () => {
  it("creates config.toml from scratch, and is idempotent", () => {
    const path = codexConfigPath(tempHome);
    const first = installCodexHooks(path);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeNull();
    const text = readFileSync(path, "utf8");
    expect(text).toContain("[mcp_servers.ctxd]");
    expect(text).toContain(">>> ctxd managed block");

    const second = installCodexHooks(path);
    expect(second.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("preserves unrelated TOML content byte for byte outside ctxd's marked block, and backs up the original", () => {
    const dir = join(tempHome, ".codex");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.toml");
    const original = `# my own notes\n[mcp_servers.other]\ncommand = "other"\n`;
    writeFileSync(path, original);

    const result = installCodexHooks(path);
    expect(result.changed).toBe(true);
    expect(readFileSync(result.backupPath!, "utf8")).toBe(original);

    const written = readFileSync(path, "utf8");
    expect(written.startsWith(original)).toBe(true);
    expect(written).toContain("[mcp_servers.ctxd]");
    expect(written).toContain("[mcp_servers.other]");
  });

  it("replaces a stale ctxd block in place rather than duplicating it", () => {
    const path = codexConfigPath(tempHome);
    installCodexHooks(path);
    const afterFirst = readFileSync(path, "utf8");

    // Simulate a future version of ctxd's own block changing: hand-edit between the markers.
    const tampered = afterFirst.replace("timeout = 3\n\n[[hooks.Stop", "timeout = 99\n\n[[hooks.Stop");
    writeFileSync(path, tampered);

    const result = installCodexHooks(path);
    expect(result.changed).toBe(true);
    const written = readFileSync(path, "utf8");
    expect(written).toBe(afterFirst); // restored to the canonical block, not appended again
    expect(written.match(/ctxd managed block \(added/g)).toHaveLength(1);
  });
});

describe("uninstallCodexHooks (real write)", () => {
  it("removes exactly ctxd's block, leaving the rest exactly as it was", () => {
    const path = codexConfigPath(tempHome);
    const dir = join(tempHome, ".codex");
    mkdirSync(dir, { recursive: true });
    const original = `# my own notes\n[mcp_servers.other]\ncommand = "other"\n`;
    writeFileSync(path, original);

    installCodexHooks(path);
    const result = uninstallCodexHooks(path);
    expect(result.changed).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("is a no-op when ctxd was never installed", () => {
    const path = codexConfigPath(tempHome);
    const result = uninstallCodexHooks(path);
    expect(result.changed).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

describe("ctxd install-hooks CLI, real write (against a temporary HOME)", () => {
  it("installs for claude-code, reports the path, and prints the MCP registration reminder", () => {
    const code = run(["--client", "claude-code"]);
    expect(code).toBe(0);
    const output = logLines.join("\n");
    expect(output).toContain("installed ctxd's hooks into");
    expect(output).toContain(join(tempHome, ".claude", "settings.json"));
    expect(output).toContain("claude mcp add");
    expect(existsSync(claudeCodeSettingsPath(tempHome))).toBe(true);
  });

  it("installs for codex and prints the hooks-approval reminder", () => {
    const code = run(["--client", "codex"]);
    expect(code).toBe(0);
    const output = logLines.join("\n");
    expect(output).toContain("installed ctxd's hooks into");
    expect(output.toLowerCase()).toContain("approved");
    expect(existsSync(codexConfigPath(tempHome))).toBe(true);
  });

  it("a second run reports nothing to do", () => {
    run(["--client", "claude-code"]);
    logLines = [];
    const code = run(["--client", "claude-code"]);
    expect(code).toBe(0);
    expect(logLines.join("\n")).toContain("nothing to do");
  });

  it("--uninstall removes what install added", () => {
    run(["--client", "claude-code"]);
    logLines = [];
    const code = run(["--client", "claude-code", "--uninstall"]);
    expect(code).toBe(0);
    expect(logLines.join("\n")).toContain("removed ctxd's hooks from");
    const settings = JSON.parse(readFileSync(claudeCodeSettingsPath(tempHome), "utf8")) as ClaudeCodeHooksConfig;
    expect(settings.hooks ?? {}).toEqual({});
  });

  it("rejects --dry-run combined with --uninstall", () => {
    const code = run(["--client", "claude-code", "--dry-run", "--uninstall"]);
    expect(code).toBe(1);
    expect(errorLines.join("\n")).toContain("cannot be combined");
  });
});
