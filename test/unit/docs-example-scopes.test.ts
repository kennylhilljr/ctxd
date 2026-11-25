// AGENTS.md: no real project, scope or pool names in the repository. Example
// refs in these LLDs must use an invented scope (such as sample-app), never the
// project's own name. The name is read from package.json so this file does not
// spell out the ref it forbids.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = ["docs/lld/LLD-write-path-v1.md", "docs/lld/LLD-briefs-search-v1.md"];
const projectName = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { name: string }).name;

// Capture the whole segment before "/" (any scope SCOPE_RE allows); skip ctxd:// URIs.
function exampleScopes(text: string): string[] {
  return [...text.matchAll(/ctxd:(?!\/\/)([^\s/`"'\]|]+)\//g)].map((match) => match[1]);
}

describe("docs example ref scopes", () => {
  for (const file of files) {
    it(`${file} does not use the project's own name as an example scope`, () => {
      const scopes = exampleScopes(readFileSync(join(process.cwd(), file), "utf8"));
      expect(scopes.length).toBeGreaterThan(0);
      expect(scopes.filter((scope) => scope === projectName)).toEqual([]);
    });
  }
});
