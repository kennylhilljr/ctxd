import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeDrift,
  intentOverlaps,
  IntentError,
  normalizeIntent,
  normalizePattern,
  pathMatches,
  patternsMayOverlap,
} from "../../src/claims/intent.js";

describe("write intent normalization (SPEC 7.5.1)", () => {
  it.each([
    ["src/sync/**", "src/sync/**"],
    ["./src//sync/", "src/sync"],
    ["src\\hooks\\nudge.ts", "src/hooks/nudge.ts"],
    ["test/*.test.ts", "test/*.test.ts"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizePattern(input)).toBe(expected);
  });

  it.each(["/etc/passwd", "\\abs", "C:/x", "../outside", "src/../../x", "!src/**", "src/{a,b}", "src/[ab].ts", "a\u0000b", "", "   ", "./"])(
    "rejects %j",
    (input) => {
      expect(() => normalizePattern(input)).toThrow(IntentError);
    },
  );

  it("keeps unknown and empty intent distinct, and dedupes and sorts", () => {
    expect(normalizeIntent(undefined)).toBeUndefined();
    expect(normalizeIntent([])).toEqual([]);
    expect(normalizeIntent(["b/**", "./a", "b/**"])).toEqual(["a", "b/**"]);
  });
});

describe("overlap test (SPEC 7.5.2)", () => {
  it.each([
    ["src/sync/**", "src/sync/apply.ts", true],
    ["src/sync/**", "test/sync/**", false],
    ["src/**", "src/sync/**", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/a.ts", "src/a.ts", true],
    ["**/*.md", "docs/prd/PRD-v2.md", true],
    ["test/sync/**", "test/sync/fixtures.ts", true],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(patternsMayOverlap(a, b)).toBe(expected);
    expect(patternsMayOverlap(b, a)).toBe(expected);
  });

  it("treats unknown and empty intent as overlapping nothing", () => {
    expect(intentOverlaps(undefined, ["src/**"])).toEqual([]);
    expect(intentOverlaps([], ["src/**"])).toEqual([]);
    expect(intentOverlaps(["src/sync/**"], ["src/sync/apply.ts", "docs/**"])).toEqual([
      { mine: "src/sync/**", theirs: "src/sync/apply.ts" },
    ]);
  });

  it("never misses a real overlap (property test against generated paths)", () => {
    const seg = fc.constantFrom("src", "test", "sync", "hooks", "a.ts", "b.ts", "x");
    const path = fc.array(seg, { minLength: 1, maxLength: 4 }).map((s) => s.join("/"));
    const pattern = fc
      .tuple(fc.array(seg, { minLength: 0, maxLength: 3 }), fc.constantFrom("", "/**", "/*", "/*.ts"))
      .map(([s, tail]) => (s.join("/") + tail).replace(/^\//, "") || "**");
    fc.assert(
      fc.property(pattern, pattern, path, (p1, p2, file) => {
        const a = normalizePattern(p1);
        const b = normalizePattern(p2);
        if (pathMatches(file, a) && pathMatches(file, b)) {
          expect(patternsMayOverlap(a, b)).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe("drift audit (SPEC 7.5.4)", () => {
  it("reports changed files outside declared paths", () => {
    expect(computeDrift(["test/sync/**"], ["test/sync/apply.test.ts", "src/sync/apply.ts"])).toEqual([
      "src/sync/apply.ts",
    ]);
  });

  it("is unknown when intent or changes are unknown", () => {
    expect(computeDrift(undefined, ["a.ts"])).toBeUndefined();
    expect(computeDrift(["a.ts"], undefined)).toBeUndefined();
  });

  it("treats every change as drift for a no-writes claim", () => {
    expect(computeDrift([], ["README.md"])).toEqual(["README.md"]);
  });

  it("accepts literal file names with bracket characters", () => {
    expect(computeDrift(["docs/**"], ["docs/[draft].md", "src/x.ts"])).toEqual(["src/x.ts"]);
  });
});
