import type Database from "better-sqlite3";

/**
 * `scope_repos` bindings (SPEC v6 section 3). `repo` must already be a normalized origin
 * (see `normalizeOriginUrl` in `src/hooks/scope.ts`), never a raw URL.
 */

/** Bind (or rebind) a repository identity to a scope. */
export function bindScope(db: Database.Database, repo: string, scopeId: string): void {
  db.prepare(
    "INSERT INTO scope_repos (repo, scope_id) VALUES (?, ?) ON CONFLICT(repo) DO UPDATE SET scope_id = excluded.scope_id",
  ).run(repo, scopeId);
}

/** Remove a repository's binding. Returns true if a binding existed. */
export function unbindScope(db: Database.Database, repo: string): boolean {
  return db.prepare("DELETE FROM scope_repos WHERE repo = ?").run(repo).changes > 0;
}
