import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Mechanical check of the test plan (AGENTS.md: "the test plan maps every ID to its tests"; issue 77).
 * Every acceptance criterion in the latest component PRDs has exactly one row, the reported counts
 * match the rows, and every test link points at a test whose title it quotes.
 */

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const plan = read("docs/test/test-plan-v1.md");
// Rows in the per-component sections; the "Gaps to close first" table above them repeats some IDs.
const sections = plan.slice(plan.indexOf("\n## BS:"));
const rows = [...sections.matchAll(/^\| ([A-Z]+-AC-\d+) \| ([A-Za-z ]+?) \|/gm)].map((m) => ({ id: m[1]!, status: m[2]! }));

function latestComponentPrds(): string[] {
  const readme = read("docs/README.md");
  const table = readme.slice(readme.indexOf("## Components"), readme.indexOf("## Conventions"));
  return [...table.matchAll(/\]\((prd\/components\/PRD-[\w-]+-v\d+\.md)\)/g)].map((m) => `docs/${m[1]}`);
}

describe("test plan traceability", () => {
  it("maps every acceptance criterion of the latest component PRDs exactly once, and nothing else", () => {
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const defined = new Set<string>();
    for (const prd of latestComponentPrds()) {
      for (const m of read(prd).matchAll(/^\| ([A-Z]+-AC-\d+) \|/gm)) defined.add(m[1]!);
    }
    expect(defined.size).toBeGreaterThan(0);
    expect([...ids].sort()).toEqual([...defined].sort());
  });

  it("reports counts that match the rows", () => {
    const count = (status: string) => rows.filter((r) => r.status === status).length;
    const expected = `Counts: **${rows.length} criteria**; Covered: ${count("Covered")}, Diverges: ${count("Diverges")}, Gap: ${count("Gap")}, Partial: ${count("Partial")}.`;
    expect(plan).toContain(expected);
  });

  it("links every test reference to a test or describe declaration with the quoted title", () => {
    const links = [...plan.matchAll(/\[`[\w.-]+\.test\.ts:(\d+)`\]\(\.\.\/\.\.\/(test\/[\w/.-]+)#L(\d+)\) ([^<|]+)/g)];
    expect(links.length).toBeGreaterThan(0);
    const stale: string[] = [];
    for (const [, line, path, anchor, title] of links) {
      if (line !== anchor || !existsSync(join(root, path!))) {
        stale.push(`${path}:${line}`);
        continue;
      }
      const source = read(path!).split("\n")[Number(line) - 1] ?? "";
      const quoted = title!.replaceAll("`", "").trim().slice(0, 40);
      if (!/\b(it|test|describe)(\.\w+)?\(/.test(source) || !source.includes(quoted)) stale.push(`${path}:${line} ${quoted}`);
    }
    expect(stale).toEqual([]);
  });

  it("cites each security hardening criterion from issue 77 in at least one test", () => {
    const tests = ["sealed-key-transfer-http", "sync-peer-binding", "sync-acl", "mirror"].map((f) => read(`test/unit/${f}.test.ts`)).join("\n");
    const ids = [
      ...[14, 15, 16, 17, 18].map((n) => `PA-AC-${n}`),
      ...[7, 8, 9, 10, 11].map((n) => `RP-AC-${n}`),
      ...[6, 7, 8, 9, 10, 11].map((n) => `FS-AC-${n}`),
    ];
    expect(ids.filter((id) => !new RegExp(`\\b${id}\\b`).test(tests))).toEqual([]);
  });
});
