// AGENTS.md: no real project, scope or pool names in the repository. Example
// refs in these LLDs must use one of the invented scopes AGENTS.md lists.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = ["docs/lld/LLD-write-path-v1.md", "docs/lld/LLD-briefs-search-v1.md"];
const inventedScopes = new Set(["sample-app", "notes", "project-b", "shared-tools", "private-a"]);

function exampleScopes(text: string): string[] {
  return [...text.matchAll(/ctxd:([a-z0-9-]+)\//g)].map((match) => match[1]);
}

describe("docs example ref scopes", () => {
  for (const file of files) {
    it(`${file} uses only invented scopes in example refs`, () => {
      const scopes = exampleScopes(readFileSync(join(process.cwd(), file), "utf8"));
      expect(scopes.length).toBeGreaterThan(0);
      expect(scopes.filter((scope) => !inventedScopes.has(scope))).toEqual([]);
    });
  }
});
