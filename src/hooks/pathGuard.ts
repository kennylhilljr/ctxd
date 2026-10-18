/**
 * Path guard (SPEC v6 section 9.9): PreToolUse inspects file-tool inputs and, for Bash, the
 * command text, denying any call that resolves under a guarded ctxd path. Matching is by path
 * prefix after `~` expansion and normalization; this is a guard against accidents and casual
 * bypass, not a sandbox.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { expandHome } from "../config/config.js";

export const PATH_GUARD_DENY_REASON =
  "ctxd data is managed by the ctxd server. Use context_search or context_get to read it, and context_write to change it.";

export interface PathGuardResult {
  blocked: boolean;
  reason?: string;
}

function normalize(path: string): string {
  return resolve(expandHome(path));
}

/** True if `candidate` resolves to, or under, any of `guardedPrefixes` (both normalized first). */
function underGuardedPrefix(candidate: string, guardedPrefixes: readonly string[]): boolean {
  const resolved = normalize(candidate);
  return guardedPrefixes.some((prefix) => {
    const p = normalize(prefix);
    return resolved === p || resolved.startsWith(`${p}/`);
  });
}

/** Whether a shell command's text mentions a guarded path, as a literal path or its `~`-shorthand. */
function commandMentionsGuardedPath(command: string, guardedPrefixes: readonly string[]): boolean {
  const home = homedir();
  return guardedPrefixes.some((prefix) => {
    const normalized = normalize(prefix);
    if (command.includes(normalized)) return true;
    if (normalized.startsWith(home)) {
      const shorthand = `~${normalized.slice(home.length)}`;
      if (command.includes(shorthand)) return true;
    }
    return false;
  });
}

/** Keys file tools (Read, Edit, Write, MultiEdit, Glob, Grep) use for a target path, across clients. */
const FILE_PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

const BASH_TOOL_NAMES = new Set(["bash", "Bash"]);

/**
 * Check one PreToolUse call against the guarded prefixes. `toolInput` is the client's own
 * `tool_input` object, read as-is (its shape varies by tool, so this only looks at the handful
 * of keys file tools and Bash are documented to use).
 */
export function checkPathGuard(toolName: string | undefined, toolInput: Record<string, unknown>, guardedPrefixes: readonly string[]): PathGuardResult {
  for (const key of FILE_PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value === "string" && value.length > 0 && underGuardedPrefix(value, guardedPrefixes)) {
      return { blocked: true, reason: PATH_GUARD_DENY_REASON };
    }
  }
  if (toolName && BASH_TOOL_NAMES.has(toolName)) {
    const command = toolInput.command;
    if (typeof command === "string" && commandMentionsGuardedPath(command, guardedPrefixes)) {
      return { blocked: true, reason: PATH_GUARD_DENY_REASON };
    }
  }
  return { blocked: false };
}
