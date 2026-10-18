/**
 * Mechanical git facts for the write-moments hooks (SPEC v6 9.2's PreCompact, Stop, SessionEnd
 * and PostToolUse rows): branch, HEAD, changed files and a working-tree fingerprint. Shells out
 * to `git` directly, scoped to a hook's own `cwd`; returns null/empty on any failure (not a git
 * repo, no `git` on PATH, timeout) rather than throwing, since none of these facts may ever break
 * a hook (SPEC 9.1).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function gitHead(cwd: string): string | null {
  return git(cwd, ["rev-parse", "HEAD"]);
}

export function gitBranch(cwd: string): string | null {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === null || branch === "HEAD" ? null : branch; // "HEAD" itself means detached
}

function statusPorcelain(cwd: string): string | null {
  return git(cwd, ["status", "--porcelain"]);
}

/** Changed (including untracked) file paths from `git status --porcelain`, status markers stripped. */
export function gitChangedFiles(cwd: string): string[] {
  const porcelain = statusPorcelain(cwd);
  if (!porcelain) return [];
  return porcelain
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim().split(" -> ").pop()!.trim());
}

/** HEAD plus a short hash of the working tree's dirty state, or null outside git (SPEC 9.2, 9.3). */
export function headFingerprint(cwd: string): string | null {
  const head = gitHead(cwd);
  if (head === null) return null;
  const dirty = createHash("sha1").update(statusPorcelain(cwd) ?? "").digest("hex").slice(0, 8);
  return `${head}:${dirty}`;
}

/** The current commit's sha and subject, or null outside git / with no commits yet. */
export function latestCommit(cwd: string): { sha: string; subject: string } | null {
  const sha = gitHead(cwd);
  if (sha === null) return null;
  const subject = git(cwd, ["log", "-1", "--format=%s"]);
  return subject === null ? null : { sha, subject };
}

/** Files changed by the current commit (SPEC 9.2's PostToolUse row). */
export function latestCommitFiles(cwd: string): string[] {
  const out = git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
  return out ? out.split("\n").filter((l) => l.length > 0) : [];
}
