// AGENTS.md: no real project, scope or pool names in the repository. Example
// refs in these LLDs use an invented scope (sample-app), not the project's own name.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = ["docs/lld/LLD-write-path-v1.md", "docs/lld/LLD-briefs-search-v1.md"];

describe("docs example ref scopes", () => {
  for (const file of files) {
    it(`${file} uses an invented scope in example refs`, () => {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      expect(text).not.toContain("ctxd:ctxd/");
      expect(text).toContain("ctxd:sample-app/01JAB");
    });
  }
});
