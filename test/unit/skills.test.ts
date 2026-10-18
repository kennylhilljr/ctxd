import { describe, expect, it } from "vitest";
import { buildCatalog, catalogLine, parseSkill, renderSyncedSkill, skillSummary } from "../../src/skills/skillmd.js";

const BODY = `---
name: release-checklist
description: >
  How to cut a release of sample-app: version bump, changelog,
  tag and verification. Use when asked to release.
when_to_use: "Before tagging"
allowed-tools:
  - Bash(git tag:*)
  - Bash(npm publish:*)
---
# Release checklist

1. Run the tests.
`;

describe("SKILL.md validation (SPEC v6 4.3)", () => {
  it("parses name, a folded description and keeps other keys", () => {
    const s = parseSkill("release-checklist", BODY);
    expect(s.name).toBe("release-checklist");
    expect(s.description).toBe(
      "How to cut a release of sample-app: version bump, changelog, tag and verification. Use when asked to release.",
    );
    expect(s.keys).toEqual(["name", "description", "when_to_use", "allowed-tools"]);
    expect(s.instructions).toContain("# Release checklist");
    expect(skillSummary(s).length).toBeLessThanOrEqual(200);
  });

  it.each([
    ["Release", BODY, /title must be the skill name/],
    ["release--checklist", BODY, /title must be the skill name/],
    ["other-name", BODY, /must equal the title/],
    ["release-checklist", "# no frontmatter", /must start with/],
    ["release-checklist", "---\nname: release-checklist\n", /not closed/],
    ["release-checklist", "---\nname: release-checklist\n---\nbody", /needs a description/],
    ["release-checklist", `---\nname: release-checklist\ndescription: ${"d".repeat(1025)}\n---\n`, /1 to 1024/],
  ])("rejects title %s", (title, body, err) => {
    expect(() => parseSkill(title, body)).toThrow(err);
  });

  it("accepts quoted values and CRLF line endings", () => {
    const s = parseSkill("a-b", "---\r\nname: 'a-b'\r\ndescription: \"Does a thing\"\r\n---\r\nText\r\n");
    expect(s.description).toBe("Does a thing");
  });
});

describe("catalog and sync (SPEC v6 11.1, 12.2)", () => {
  it("formats catalog lines and respects the budget", () => {
    const line = catalogLine({ name: "x", description: "word ".repeat(60) }, "claude-code@laptop");
    expect(line.startsWith("- x: ")).toBe(true);
    expect(line.endsWith("(claude-code@laptop)")).toBe(true);
    const { text, omitted } = buildCatalog([line, line, line, line, line, line], 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(omitted).toBeGreaterThan(0);
  });

  it("strips allowed-tools by default and marks the file as managed", () => {
    const out = renderSyncedSkill(BODY, "ctxd:_me/01JAB");
    expect(out).not.toContain("allowed-tools");
    expect(out).not.toContain("npm publish");
    expect(out).toContain("when_to_use");
    expect(out).toContain("<!-- ctxd:_me/01JAB: managed by ctxd");
    expect(parseSkill("release-checklist", out).name).toBe("release-checklist");
    expect(renderSyncedSkill(BODY, "r", true)).toContain("allowed-tools");
  });
});

describe("SKILL.md edge cases (review findings)", () => {
  it("closes frontmatter only on an exact --- line", () => {
    expect(() => parseSkill("a", "---\nname: a\ndescription: d\n---more\n")).toThrow(/not closed/);
  });

  it("handles block scalar modifiers, plain continuations and comments", () => {
    expect(parseSkill("a", "---\nname: a\ndescription: >+\n  folded\n  text\n---\n").description).toBe("folded text");
    expect(parseSkill("a", "---\nname: a\ndescription: starts here\n  and continues\n---\n").description).toBe(
      "starts here and continues",
    );
    expect(parseSkill("a", "---\nname: a # the name\ndescription: d\n---\n").name).toBe("a");
    expect(parseSkill("a", '---\nname: a\ndescription: "keeps # inside quotes"\n---\n').description).toBe(
      "keeps # inside quotes",
    );
  });

  it.each([
    '---\nname: a\ndescription: d\n"allowed-tools": Bash(rm:*)\n---\nx',
    "---\nname: a\ndescription: d\nallowed-tools : Bash\n---\nx",
    "---\nname: a\nallowed-tools:\n  - Bash\n\n  - Read\ndescription: d\n---\nx",
  ])("strips every form of allowed-tools: %#", (body) => {
    const out = renderSyncedSkill(body, "r");
    expect(out.toLowerCase()).not.toContain("allowed-tools");
    expect(out).not.toMatch(/Bash|Read/);
    expect(parseSkill("a", out).description).toBe("d");
  });
});
