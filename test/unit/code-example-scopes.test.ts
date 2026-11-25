// AGENTS.md: no real project, scope or pool names in the repository. Example
// scopes in code comments and test fixtures must be invented (such as
// sample-app), never the project's own name. The name is read from package.json
// so this file does not spell out the scope it forbids. Product uses of the name
// (the ctxd: ref prefix, the status line label, the hook command, the keychain
// service) are not scopes and are not matched. Every .ts file under src/ and
// test/ is checked.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const projectName = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string }).name;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [relative(root, path)] : [];
  });
}

const name = projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Scope positions: refs (ctxd:<scope>/), scope/scopeId/id properties, the nudge
// reason (scope "<scope>"), formatRef/initialSessionState arguments, a scopes
// fixture key, the status line scope after the health dot and an SQL scope row.
const SCOPE_PATTERNS = [
  new RegExp(`ctxd:${name}/`),
  new RegExp(`\\b(?:scope|scopeId|id)\\s*:\\s*["'\`]${name}["'\`]`),
  new RegExp(`scope ["'\`]${name}["'\`]`),
  new RegExp(`\\b(?:formatRef|initialSessionState)\\(\\s*["'\`]${name}["'\`]`),
  new RegExp(`\\bscopes\\.${name}\\b`),
  new RegExp(`● ${name} `),
  new RegExp(`VALUES \\([^)]*'${name}'`),
];

function scopeUses(text: string): string[] {
  return text.split("\n").filter((line) => SCOPE_PATTERNS.some((pattern) => pattern.test(line)));
}

describe("code example scopes", () => {
  it("recognizes each form and ignores product uses of the name", () => {
    const forms = [
      `"[ctxd:${projectName}/01JAB... | decision ]"`,
      `{ scope: "${projectName}" }`,
      `{ scopeId: "${projectName}" }`,
      `{ id: "${projectName}", kind: "project" }`,
      `toContain('scope "${projectName}"')`,
      `formatRef("${projectName}", ID)`,
      `initialSessionState("${projectName}", "old")`,
      `scopes.${projectName}!`,
      `"ctxd ● ${projectName} · brief"`,
      `VALUES ('s1','${projectName}','t')`,
    ];
    for (const form of forms) expect(scopeUses(form)).toEqual([form]);
    const productUses = [
      `ctxd:_me/01JAB...`,
      `ctxd:sample-app/01JAB...`,
      `{ type: "command", command: "${projectName}" }`,
      `const SERVICE = "${projectName}";`,
      `new Server({ name: "${projectName}", version: "0.0.1" })`,
      `"ctxd ● sample-app · brief"`,
    ];
    for (const use of productUses) expect(scopeUses(use)).toEqual([]);
  });

  for (const file of [...tsFiles(join(root, "src")), ...tsFiles(join(root, "test"))]) {
    it(`${file} does not use the project's own name as an example scope`, () => {
      expect(scopeUses(readFileSync(join(root, file), "utf8"))).toEqual([]);
    });
  }
});
