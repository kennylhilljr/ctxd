import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { patternToRegex } from "../claims/intent.js";

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

/** Full resolution (SPEC v3 section 3) needs the store's scope_repos; implemented in M2. */
export function resolveScope(_cwd: string): string | null {
  throw new Error("resolveScope is not implemented yet (planned for M2).");
}
