import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KINDS, type Kind } from "../../src/core/kinds.js";
import { entryPath, isUnder, parsePath, slugify } from "../../src/fsview/paths.js";

const ID = "01JABCDEF000000000007K2PQZ";

describe("slugs (SPEC v6 4.2)", () => {
  it.each([
    ["Use an event log, not cr-sqlite", "use-an-event-log-not-cr-sqlite-7k2pqz"],
    ["Café déjà vu", "cafe-deja-vu-7k2pqz"],
    ["  --!!--  ", "decision-7k2pqz"],
    ["日本語のタイトル", "decision-7k2pqz"],
    [
      "A very long title that keeps going well past the forty eight character limit",
      "a-very-long-title-that-keeps-going-well-past-the-7k2pqz",
    ],
    ["x".repeat(60), `${"x".repeat(48)}-7k2pqz`],
  ])("%s", (title, slug) => {
    expect(slugify(title, ID, "decision")).toBe(slug);
  });
});

describe("paths (SPEC v6 4.2)", () => {
  it("lays out each kind", () => {
    const base = { scope: "sample-app", scopeKind: "project" as const, slug: "s-7k2pqz" };
    expect(entryPath({ ...base, kind: "decision" })).toBe("ctxd://sample-app/decisions/s-7k2pqz.md");
    expect(entryPath({ ...base, kind: "status" })).toBe("ctxd://sample-app/status/s-7k2pqz.md");
    expect(entryPath({ ...base, kind: "brief" })).toBe("ctxd://sample-app/brief.md");
    expect(entryPath({ ...base, kind: "fact" })).toBe("ctxd://sample-app/facts/s-7k2pqz.md");
    expect(entryPath({ ...base, scope: "_me", scopeKind: "me", kind: "fact" })).toBe("ctxd://_me/profile/s-7k2pqz.md");
    expect(entryPath({ ...base, kind: "skill", skillName: "release-checklist" })).toBe(
      "ctxd://sample-app/skills/release-checklist/SKILL.md",
    );
    expect(
      entryPath({ ...base, kind: "journal", createdAt: new Date("2026-10-18T14:00:00Z"), timeZone: "UTC" }),
    ).toBe("ctxd://sample-app/journal/2026/10/18.md#s-7k2pqz");
  });

  it("round-trips every entry path through the parser", () => {
    const plain = KINDS.filter((k) => !["brief", "skill", "journal"].includes(k)) as Kind[];
    fc.assert(
      fc.property(
        fc.constantFrom(...plain),
        fc.constantFrom(["project", "notes"], ["me", "_me"], ["profile", "_me.pool-notes"]) as fc.Arbitrary<
          ["project" | "me" | "profile", string]
        >,
        fc.string({ maxLength: 80 }),
        fc.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
        (kind, [scopeKind, scope], title, id) => {
          const slug = slugify(title, id, kind);
          const p = parsePath(entryPath({ scope, scopeKind, kind, slug }));
          expect(p).toMatchObject({ type: "entry", scope, kind, slug });
        },
      ),
      { numRuns: 500 },
    );
  });

  it("parses folders, summaries, skills and journal days", () => {
    expect(parsePath("ctxd://")).toEqual({ type: "root" });
    expect(parsePath("ctxd://_me.pool-notes/")).toEqual({ type: "scope", scope: "_me.pool-notes" });
    expect(parsePath("ctxd://notes/decisions/")).toEqual({ type: "folder", scope: "notes", folder: "decisions", kind: "decision" });
    expect(parsePath("ctxd://notes/lessons/.overview")).toMatchObject({
      type: "summary", of: { at: "kind", folder: "lessons" }, file: ".overview",
    });
    expect(parsePath("ctxd://.abstract")).toEqual({ type: "summary", of: { at: "root" }, file: ".abstract" });
    expect(parsePath("ctxd://notes/skills/foo/.abstract")).toMatchObject({ of: { at: "skill", name: "foo" } });
    expect(parsePath("ctxd://notes/journal/2026/.overview")).toMatchObject({ of: { at: "journal", year: "2026" } });
    expect(parsePath("ctxd://notes/journal/2026/10/.abstract")).toMatchObject({ of: { at: "journal", month: "10" } });
    expect(parsePath("ctxd://_me/profile/")).toMatchObject({ type: "folder", kind: "fact" });
    expect(parsePath("ctxd://notes/skills/release-checklist/SKILL.md")).toEqual({
      type: "skill", scope: "notes", name: "release-checklist", file: true,
    });
    expect(parsePath("ctxd://notes/journal/2026/10")).toEqual({ type: "journal", scope: "notes", year: "2026", month: "10" });
    expect(parsePath("ctxd://notes/journal/2026/10/18.md#tests-green-7k2pqz")).toMatchObject({
      type: "journalDay", day: "18", slug: "tests-green-7k2pqz",
    });
  });

  it.each([
    "file:///etc/passwd",
    "ctxd://notes/../_hold.codex@laptop/notes/x.md",
    "ctxd://notes//decisions",
    "ctxd://notes/secrets/x.md",
    "ctxd://Notes/decisions/",
    "ctxd://notes/decisions/x.txt",
    "ctxd://notes/decisions/a/b.md",
    "ctxd://notes/skills/Bad_Name/SKILL.md",
    "ctxd://notes/journal/2026/13",
    "ctxd://notes/decisions/x-1.md#frag",
    "ctxd://notes/journal/2026#abc",
    "ctxd://notes/journal/2026/02/31.md",
    "ctxd://notes/journal/2026/10/18.md/extra",
    "ctxd://notes/profile/x-1.md",
    "ctxd://_me/facts/x-1.md",
    "ctxd://notes/skills/.abstract",
  ])("rejects %s", (p) => {
    expect(() => parsePath(p)).toThrow(/Invalid ctxd path/);
  });

  it("tests folder containment without prefix confusion", () => {
    expect(isUnder("ctxd://notes/decisions/a-1.md", "ctxd://notes/decisions/")).toBe(true);
    expect(isUnder("ctxd://notes/decisions/a-1.md", "ctxd://notes")).toBe(true);
    expect(isUnder("ctxd://notes-archive/decisions/a-1.md", "ctxd://notes")).toBe(false);
  });
});
