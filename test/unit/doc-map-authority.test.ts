import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/README.md is authoritative for which LLD and contract version is latest, and the latest Spec's
 * routing links follow it in place (AGENTS.md "Read first"; issue 90: Spec v10 routed sections 8 and 12
 * to superseded LLD versions).
 */

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readme = read("docs/README.md");
// The authoritative part of the map: the layer tables and the component table, not the history below them.
const map = readme.slice(0, readme.indexOf("## Conventions"));
// LLDs, contracts and the test plan: the L4 documents the map versions (issue 102 added the test plan).
const designLink = /\]\(((?:\.\.\/)?(?:lld|contracts|test)\/([\w-]+)-v(\d+)\.md)/g;
const designDirs = ["lld", "contracts", "test"];

function links(text: string): { path: string; name: string; version: number }[] {
  return [...text.matchAll(designLink)].map((m) => ({
    path: m[1]!.replace(/^\.\.\//, ""),
    name: m[2]!,
    version: Number(m[3]),
  }));
}

function isLatest(path: string, name: string, version: number): boolean {
  const dir = path.slice(0, path.indexOf("/"));
  return existsSync(join(root, "docs", path)) && !existsSync(join(root, "docs", dir, `${name}-v${version + 1}.md`));
}

function latestSpec(): string {
  const m = /\[Spec v\d+\]\((spec\/SPEC-v\d+\.md)\)/.exec(map);
  expect(m).not.toBeNull();
  return `docs/${m![1]}`;
}

describe("doc map is authoritative for latest LLD, contract and test plan versions (issues 90, 102)", () => {
  it("the map lists only the latest version of each LLD and contract", () => {
    const listed = links(map);
    expect(listed.length).toBeGreaterThan(0);
    for (const l of listed) expect(isLatest(l.path, l.name, l.version), l.path).toBe(true);
  });

  it("the map lists the latest version of every LLD and contract on disk", () => {
    const mapped = new Set(links(map).map((l) => l.path));
    const latest = new Map<string, { path: string; version: number }>();
    for (const dir of designDirs) {
      for (const file of readdirSync(join(root, "docs", dir))) {
        const m = /^([\w-]+)-v(\d+)\.md$/.exec(file);
        if (!m) continue;
        const key = `${dir}/${m[1]}`;
        const version = Number(m[2]);
        if ((latest.get(key)?.version ?? 0) < version) latest.set(key, { path: `${dir}/${file}`, version });
      }
    }
    expect(latest.size).toBeGreaterThan(0);
    for (const { path } of latest.values()) expect(mapped.has(path), `${path} is missing from docs/README.md`).toBe(true);
  });

  it("the latest Spec routes every section to the LLD or contract version the map lists", () => {
    const spec = read(latestSpec());
    // Routing tables and section summaries: everything from the section table on, except the change list
    // above it and section 16 (open issues), whose resolved items record history.
    const start = spec.indexOf("## How this spec is organized");
    const openIssues = spec.search(/^## 16\. /m);
    const afterOpenIssues = spec.slice(openIssues + 1).search(/^## \d+\. /m);
    const routing =
      spec.slice(start, openIssues) + (afterOpenIssues < 0 ? "" : spec.slice(openIssues + 1 + afterOpenIssues));
    const mapped = new Set(links(map).map((l) => l.path));
    const routed = links(routing);
    expect(routed.length).toBeGreaterThan(0);
    for (const l of routed) expect(mapped.has(l.path), `${l.path} is not the version docs/README.md lists`).toBe(true);
    // The section table names a file for every LLD and contract the map lists.
    const table = links(routing.slice(0, routing.indexOf("### Traceability")));
    const tabled = new Set(table.map((l) => l.path));
    for (const path of mapped) expect(tabled.has(path), `${path} is missing from the Spec's section table`).toBe(true);
  });

  it("the Spec's Related row and AGENTS.md link the test plan the map lists (issue 102)", () => {
    const mapped = links(map).filter((l) => l.path.startsWith("test/"));
    expect(mapped.map((l) => l.name)).toEqual(["test-plan"]);
    const related = read(latestSpec()).split("\n").find((line) => line.startsWith("| **Related** |"));
    expect(related).toBeDefined();
    const agents = read("AGENTS.md").replaceAll("](docs/", "](");
    for (const text of [related!, agents]) {
      const plans = links(text).filter((l) => l.path.startsWith("test/"));
      expect(plans.length).toBeGreaterThan(0);
      for (const l of plans) expect(l.path).toBe(mapped[0]!.path);
    }
  });

  it("every later version of an L4 document names the version it supersedes (issue 102)", () => {
    const missing: string[] = [];
    for (const dir of designDirs) {
      for (const file of readdirSync(join(root, "docs", dir))) {
        const m = /^([\w-]+)-v(\d+)\.md$/.exec(file);
        if (!m || m[2] === "1") continue;
        const previous = `${m[1]}-v${Number(m[2]) - 1}.md`;
        const row = read(`docs/${dir}/${file}`).split("\n").find((line) => line.startsWith("| **Supersedes** |"));
        if (!row?.includes(`](${previous})`)) missing.push(`${dir}/${file} does not supersede ${previous}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("AGENTS.md states the rule without a new HLD version per LLD version", () => {
    const agents = read("AGENTS.md");
    const rule = agents.split("\n").find((line) => line.includes("is authoritative for which version of each document is latest"));
    expect(rule).toBeDefined();
    expect(rule).toContain("not a new HLD version");
    expect(rule).toContain("follow the map");
    expect(rule).not.toMatch(/[–—]|--/);
  });
});
