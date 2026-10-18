import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KINDS, RELATION_TYPES, SIGNIFICANCES } from "../../src/core/kinds.js";
import { explainImportance, importance, type ImportanceInput } from "../../src/model/importance.js";

const NOW = Date.parse("2026-10-18T00:00:00Z");
const DAY = 86_400_000;

const arb: fc.Arbitrary<ImportanceInput> = fc.record({
  kind: fc.constantFrom(...KINDS),
  significance: fc.constantFrom(...SIGNIFICANCES),
  inbound: fc.array(fc.constantFrom(...RELATION_TYPES), { maxLength: 30 }),
  updatedAt: fc.integer({ min: NOW - 2000 * DAY, max: NOW }),
  now: fc.constant(NOW),
  reads: fc.nat(10_000),
  briefed: fc.nat(10_000),
});

describe("importance (SPEC v6 11.3)", () => {
  it("keeps every part and the score within 0..1", () => {
    fc.assert(
      fc.property(arb, (e) => {
        const { score, parts } = importance(e);
        for (const v of [score, ...Object.values(parts)]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it("never decreases with more links, more use or a newer update", () => {
    fc.assert(
      fc.property(arb, fc.constantFrom(...RELATION_TYPES), fc.nat(50), (e, extra, bump) => {
        const base = importance(e).score;
        expect(importance({ ...e, inbound: [...e.inbound, extra] }).score).toBeGreaterThanOrEqual(base);
        expect(importance({ ...e, reads: e.reads + bump }).score).toBeGreaterThanOrEqual(base);
        expect(importance({ ...e, updatedAt: Math.min(NOW, e.updatedAt + bump * DAY) }).score).toBeGreaterThanOrEqual(base);
      }),
    );
  });

  it("weights journal entries by significance and halves recency every 90 days", () => {
    const e = { kind: "journal" as const, inbound: [], now: NOW, updatedAt: NOW - 90 * DAY, reads: 0, briefed: 0 };
    expect(importance({ ...e, significance: "blocker" }).parts.weight).toBe(0.95);
    expect(importance({ ...e, significance: "routine" }).parts.weight).toBe(0.3);
    expect(importance({ ...e, significance: null }).parts.weight).toBe(0.3);
    expect(importance({ ...e, significance: "routine" }).parts.recency).toBeCloseTo(0.5, 10);
  });

  it("counts causal links double", () => {
    const e = { kind: "decision" as const, now: NOW, updatedAt: NOW, reads: 0, briefed: 0 };
    expect(importance({ ...e, inbound: ["relates_to"] }).parts.links).toBeCloseTo(0.1);
    expect(importance({ ...e, inbound: ["resolved"] }).parts.links).toBeCloseTo(0.3);
  });

  it("explains itself with the same numbers", () => {
    const i = importance({ kind: "decision", inbound: [], now: NOW, updatedAt: NOW, reads: 0, briefed: 0 });
    expect(explainImportance(i)).toBe(
      `importance ${i.score.toFixed(2)} = 0.35*weight 1.00 + 0.25*links 0.00 + 0.25*recency 1.00 + 0.15*use 0.00`,
    );
  });
});
