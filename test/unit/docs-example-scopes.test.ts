// AGENTS.md: no real project, scope or pool names in the repository. Example
// scopes in the docs (refs, ctxd:// paths, JSON "scope" values and TOML scope
// assignments) must be invented (such as sample-app), never the project's own
// name. The name is read from package.json so this file does not spell out the
// scope it forbids. Every Markdown file under docs/ is checked.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const projectName = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string }).name;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [relative(root, path)] : [];
  });
}

// Files #92 and #98 sanitized; each must keep at least one recognized example.
const filesWithExamples = [
  "docs/lld/LLD-write-path-v1.md",
  "docs/lld/LLD-briefs-search-v1.md",
  "docs/contracts/mcp-tools-v1.md",
  "docs/lld/LLD-hooks-v1.md",
  "docs/lld/LLD-configuration-v1.md",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `docs/spec/SPEC-v${n}.md`),
  ...[1, 2, 3, 4].map((n) => `docs/prd/components/PRD-knowledge-model-v${n}.md`),
  ...[6, 7, 8].map((n) => `docs/prd/PRD-v${n}.md`),
];

// Scope segments in: refs (ctxd:<scope>/), paths (ctxd://<scope>[/...]), JSON
// ("scope": "<scope>"), TOML (scope = "<scope>") and scope_map values
// ("<path or remote>" = "<scope>").
const SCOPE_PATTERNS = [
  /ctxd:(?!\/\/)([^\s/`"'\]|]+)\//g,
  /ctxd:\/\/([^\s/`"'\]|),.]+)/g,
  /"scope"\s*:\s*"([^"]+)"/g,
  /^\s*scope\s*=\s*"([^"]+)"/gm,
  /^\s*"[^"]+"\s*=\s*"([^"]+)"/gm,
];

function exampleScopes(text: string): string[] {
  return SCOPE_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]));
}

describe("docs example scopes", () => {
  it("recognizes each form and rejects the project's own name", () => {
    const forms = [
      `ctxd:${projectName}/01JAB...`,
      `ctxd://${projectName}/decisions/x.md`,
      `ctxd://${projectName}`,
      `{ "scope": "${projectName}" }`,
      `scope = "${projectName}"`,
      `"~/code/x" = "${projectName}"`,
    ];
    for (const form of forms) expect(exampleScopes(form)).toEqual([projectName]);
    expect(exampleScopes("ctxd:sample-app/01JAB... and ctxd://sample-app/notes")).toEqual(["sample-app", "sample-app"]);
    expect(exampleScopes("see ctxd:// and ctxd://_me")).toEqual(["_me"]);
  });

  for (const file of filesWithExamples) {
    it(`${file} has an example scope`, () => {
      expect(exampleScopes(readFileSync(join(root, file), "utf8")).length).toBeGreaterThan(0);
    });
  }

  for (const file of markdownFiles(join(root, "docs"))) {
    it(`${file} does not use the project's own name as an example scope`, () => {
      const scopes = exampleScopes(readFileSync(join(root, file), "utf8"));
      expect(scopes.filter((scope) => scope === projectName)).toEqual([]);
    });
  }
});
