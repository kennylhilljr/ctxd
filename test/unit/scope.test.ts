import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { isBypassed, normalizeOriginUrl, originFromConfig, repoIdentity, resolveScope } from "../../src/hooks/scope.js";
import { openDatabase } from "../../src/store/db.js";
import { newId } from "../../src/core/ids.js";
import { addScope, bindScopeCommand, unbindScopeCommand } from "../../src/cli/scope.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ctxd-scope-resolve-"));
  const db = openDatabase(join(dir, "ctxd.db"), { create: true });
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(newId(), new Date().toISOString());
  db.prepare(
    "INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, '_me', 'me', 'all', 'any', ?)",
  ).run(newId(), new Date().toISOString());
  return db;
}

function makeRepo(root: string, origin: string): string {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
  return root;
}

describe("origin normalization (SPEC v3 section 3)", () => {
  it.each([
    ["git@github.com:kennylhilljr/ctxd.git", "github.com/kennylhilljr/ctxd"],
    ["https://github.com/KennyLHillJr/ctxd.git", "github.com/kennylhilljr/ctxd"],
    ["https://github.com/kennylhilljr/ctxd/", "github.com/kennylhilljr/ctxd"],
    ["ssh://git@github.com/kennylhilljr/ctxd", "github.com/kennylhilljr/ctxd"],
    ["https://user:secret@gitlab.example.com/group/sub/repo.git", "gitlab.example.com/group/sub/repo"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeOriginUrl(input)).toBe(expected);
  });

  it("returns null for unrecognized input", () => {
    expect(normalizeOriginUrl("")).toBeNull();
    expect(normalizeOriginUrl("not a url")).toBeNull();
    expect(normalizeOriginUrl("/local/path/repo")).toBeNull();
  });

  it("never keeps credentials embedded in the URL", () => {
    expect(normalizeOriginUrl("https://user:secret@github.com/a/b.git")).not.toContain("secret");
  });
});

describe("repository identity without a git subprocess", () => {
  it("reads origin from .git/config, from subdirectories and worktrees", () => {
    const root = mkdtempSync(join(tmpdir(), "ctxd-scope-"));
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "config"),
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/thing.git\n[remote "origin"]\n\turl = git@github.com:kennylhilljr/ctxd.git\n',
    );
    expect(repoIdentity(join(repo, "src", "deep"))).toBe("github.com/kennylhilljr/ctxd");

    const wtGit = join(repo, ".git", "worktrees", "wt1");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    const wt = join(root, "wt1");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    expect(repoIdentity(wt)).toBe("github.com/kennylhilljr/ctxd");

    expect(repoIdentity(root)).toBeNull();
  });

  it("parses only the origin remote", () => {
    expect(originFromConfig('[remote "origin"]\n  url = https://x.org/a/b\n[branch "main"]\n  remote = origin')).toBe(
      "https://x.org/a/b",
    );
    expect(originFromConfig('[remote "upstream"]\n url = https://x.org/a/b')).toBeNull();
  });
});

describe("bypass (SPEC v3 sections 3 and 9.9)", () => {
  it("honors the environment flag", () => {
    expect(isBypassed("/Users/k/code/ctxd", [], { CTXD_BYPASS: "1" })).toBe(true);
    expect(isBypassed("/Users/k/code/ctxd", [], {})).toBe(false);
  });

  it("matches absolute and anywhere patterns", () => {
    const patterns = ["/tmp/**", "**/scratch/**"];
    expect(isBypassed("/tmp/play", patterns, {})).toBe(true);
    expect(isBypassed("/Users/k/scratch/idea", patterns, {})).toBe(true);
    expect(isBypassed("/Users/k/scratch", patterns, {})).toBe(true);
    expect(isBypassed("/Users/k/code/ctxd", patterns, {})).toBe(false);
  });
});

describe("resolveScope (SPEC v6 section 3)", () => {
  it("resolves via scope_repos when the repository is bound", () => {
    const db = freshDb();
    const scopeId = newId();
    db.prepare(
      "INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, 'sample-app', 'project', 'all', 'any', ?)",
    ).run(scopeId, new Date().toISOString());
    db.prepare("INSERT INTO scope_repos (repo, scope_id) VALUES (?, ?)").run("github.com/example/sample-app", scopeId);

    const root = mkdtempSync(join(tmpdir(), "ctxd-scope-resolve-repo-"));
    makeRepo(root, "git@github.com:example/sample-app.git");

    expect(resolveScope(db, root, {})).toEqual({ scope: "sample-app" });
    db.close();
  });

  it("falls back to a scope_map path-prefix match when the repository is not bound", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "ctxd-scope-resolve-path-"));
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });

    expect(resolveScope(db, nested, { [root]: "notes" })).toEqual({ scope: "notes" });
    // A trailing slash on the scope_map key must match the same way.
    expect(resolveScope(db, nested, { [`${root}/`]: "notes" })).toEqual({ scope: "notes" });
    db.close();
  });

  it("falls back to a scope_map remote match when the repository is not bound", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "ctxd-scope-resolve-remote-"));
    makeRepo(root, "https://github.com/example/sample-app.git");

    expect(resolveScope(db, root, { "github.com/example/sample-app": "sample-app" })).toEqual({ scope: "sample-app" });
    db.close();
  });

  it("returns the not-bound notice with the normalized origin when nothing matches", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "ctxd-scope-resolve-unbound-"));
    makeRepo(root, "git@github.com:example/sample-app.git");

    expect(resolveScope(db, root, {})).toEqual({
      scope: null,
      notice: "This repository is not bound to a ctxd scope. Bind it with: ctxd scope bind <scope> --repo github.com/example/sample-app",
    });
    db.close();
  });

  it("returns a no-origin notice outside any bound repository or scope_map entry", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "ctxd-scope-resolve-noorigin-"));

    const result = resolveScope(db, root, {});
    expect(result.scope).toBeNull();
    expect((result as { notice: string }).notice).toMatch(/not bound/i);
    expect((result as { notice: string }).notice).not.toContain("--repo");
    db.close();
  });
});

describe("ctxd scope bind/unbind (SPEC v6 sections 3, 13)", () => {
  it("binds a repository to an existing scope", () => {
    const db = freshDb();
    addScope(db, "sample-app", "all", "any");

    expect(bindScopeCommand(db, "sample-app", "github.com/example/sample-app")).toBe(0);
    const row = db.prepare("SELECT scope_id FROM scope_repos WHERE repo = ?").get("github.com/example/sample-app") as
      | { scope_id: string }
      | undefined;
    const scope = db.prepare("SELECT scope_id FROM scopes WHERE name = 'sample-app'").get() as { scope_id: string };
    expect(row?.scope_id).toBe(scope.scope_id);
    db.close();
  });

  it("refuses to bind to a scope that does not exist", () => {
    const db = freshDb();
    expect(bindScopeCommand(db, "missing", "github.com/example/sample-app")).toBe(1);
    expect(db.prepare("SELECT 1 FROM scope_repos WHERE repo = ?").get("github.com/example/sample-app")).toBeUndefined();
    db.close();
  });

  it("rebinding a repo to a different scope replaces the previous binding", () => {
    const db = freshDb();
    addScope(db, "sample-app", "all", "any");
    addScope(db, "project-b", "all", "any");
    bindScopeCommand(db, "sample-app", "github.com/example/sample-app");
    bindScopeCommand(db, "project-b", "github.com/example/sample-app");

    const scopeId = db.prepare("SELECT scope_id FROM scope_repos WHERE repo = ?").get("github.com/example/sample-app") as {
      scope_id: string;
    };
    const projectB = db.prepare("SELECT scope_id FROM scopes WHERE name = 'project-b'").get() as { scope_id: string };
    expect(scopeId.scope_id).toBe(projectB.scope_id);
    db.close();
  });

  it("unbinds a repository and reports when nothing was bound", () => {
    const db = freshDb();
    addScope(db, "sample-app", "all", "any");
    bindScopeCommand(db, "sample-app", "github.com/example/sample-app");

    expect(unbindScopeCommand(db, "github.com/example/sample-app")).toBe(0);
    expect(db.prepare("SELECT 1 FROM scope_repos WHERE repo = ?").get("github.com/example/sample-app")).toBeUndefined();
    // Unbinding again is a clean no-op, not an error.
    expect(unbindScopeCommand(db, "github.com/example/sample-app")).toBe(0);
    db.close();
  });
});
