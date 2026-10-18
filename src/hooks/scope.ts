import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { patternToRegex } from "../claims/intent.js";
import { expandHome } from "../config/config.js";

/**
 * Scope resolution helpers (SPEC v3 section 3; PRD-hooks-v2 section 2.1).
 * Repository identity is read from git config files directly; no git subprocess.
 */

/** Normalize an origin URL to host/owner/repo, lowercased, without .git. Returns null if unrecognized. */
export function normalizeOriginUrl(url: string): string | null {
  let u = url.trim();
  if (!u) return null;
  let hostPath: string | null = null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u); // git@github.com:owner/repo.git
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      if (!parsed.hostname) return null;
      hostPath = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return null;
    }
  } else if (scp) {
    hostPath = `${scp[1]}/${scp[2]}`;
  } else {
    return null;
  }
  u = hostPath
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return u.includes("/") ? u : null;
}

/** Find the repository root and its git directory, following worktree .git files. */
export function findGitDir(start: string): { root: string; gitDir: string } | null {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      const st = statSync(dotGit);
      if (st.isDirectory()) return { root: dir, gitDir: dotGit };
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (m) {
        const target = m[1]!.trim();
        return { root: dir, gitDir: isAbsolute(target) ? target : resolve(dir, target) };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read remote "origin" url from a git config file's text. */
export function originFromConfig(configText: string): string | null {
  let inOrigin = false;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line);
    if (section) {
      inOrigin = section[1] === "origin";
      continue;
    }
    if (line.startsWith("[")) {
      inOrigin = false;
      continue;
    }
    if (inOrigin) {
      const kv = /^url\s*=\s*(.+)$/.exec(line);
      if (kv) return kv[1]!.trim();
    }
  }
  return null;
}

/** Normalized repository identity for a working directory, or null outside a repo or without origin. */
export function repoIdentity(cwd: string): string | null {
  const found = findGitDir(cwd);
  if (!found) return null;
  // Worktrees keep config in the common dir; "commondir" points there.
  let configDir = found.gitDir;
  const commondir = join(found.gitDir, "commondir");
  if (existsSync(commondir)) configDir = resolve(found.gitDir, readFileSync(commondir, "utf8").trim());
  const config = join(configDir, "config");
  if (!existsSync(config)) return null;
  const origin = originFromConfig(readFileSync(config, "utf8"));
  return origin ? normalizeOriginUrl(origin) : null;
}

/** Bypass check (SPEC v3 sections 3 and 9.9). */
export function isBypassed(cwd: string, patterns: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.CTXD_BYPASS ?? "").toLowerCase();
  if (flag === "1" || flag === "true") return true;
  const path = resolve(cwd);
  return patterns.some((p) => {
    const rel = p.replace(/^\/+/, "");
    return patternToRegex(rel).test(path.replace(/^\/+/, "")) || patternToRegex(rel).test(`${path.replace(/^\/+/, "")}/`);
  });
}

/** A resolved scope, or the "not bound" case with the notice text a SessionStart brief should show. */
export type ScopeResolution = { scope: string } | { scope: null; notice: string };

function normalizePathForMatch(path: string): string {
  return resolve(expandHome(path)).replace(/\/+$/, "");
}

/** Does `pathBase` equal, or sit under, the directory named by a `scope_map` path key? */
function matchesPathPrefix(key: string, pathBase: string): boolean {
  const k = normalizePathForMatch(key);
  const p = normalizePathForMatch(pathBase);
  return p === k || p.startsWith(`${k}/`);
}

/** Does `repo` equal, or sit under, the remote named by a `scope_map` remote key (e.g. an org-level entry)? */
function matchesRemotePrefix(key: string, repo: string): boolean {
  const k = key.trim().replace(/\/+$/, "").toLowerCase();
  return repo === k || repo.startsWith(`${k}/`);
}

/** A `scope_map` key is a filesystem path (starts with `/` or `~`) or a normalized remote string otherwise. */
function isPathKey(key: string): boolean {
  return key.startsWith("/") || key.startsWith("~");
}

/** The longest-matching `scope_map` entry against `pathBase` (paths) or `repo` (remotes), or null. */
function matchScopeMap(scopeMap: Record<string, string>, pathBase: string, repo: string | null): string | null {
  let best: { key: string; value: string } | null = null;
  for (const [key, value] of Object.entries(scopeMap)) {
    const matched = isPathKey(key) ? matchesPathPrefix(key, pathBase) : repo !== null && matchesRemotePrefix(key, repo);
    if (matched && (!best || key.length > best.key.length)) best = { key, value };
  }
  return best ? best.value : null;
}

/**
 * Full scope resolution (SPEC v6 section 3): repository identity first, then a `scope_map`
 * path or remote match, then the "not bound" notice for the SessionStart brief.
 */
export function resolveScope(db: Database.Database, cwd: string, scopeMap: Record<string, string>): ScopeResolution {
  const repo = repoIdentity(cwd);
  if (repo) {
    const row = db
      .prepare(
        "SELECT scopes.name AS name FROM scope_repos JOIN scopes ON scopes.scope_id = scope_repos.scope_id WHERE scope_repos.repo = ?",
      )
      .get(repo) as { name: string } | undefined;
    if (row) return { scope: row.name };
  }
  const pathBase = findGitDir(cwd)?.root ?? resolve(cwd);
  const mapped = matchScopeMap(scopeMap, pathBase, repo);
  if (mapped) return { scope: mapped };
  const notice = repo
    ? `This repository is not bound to a ctxd scope. Bind it with: ctxd scope bind <scope> --repo ${repo}`
    : "This directory is not bound to a ctxd scope and has no git remote to bind. Add a scope_map entry for this path, or bind a repository with a remote origin.";
  return { scope: null, notice };
}
