import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBypassed, normalizeOriginUrl, originFromConfig, repoIdentity } from "../../src/hooks/scope.js";

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
