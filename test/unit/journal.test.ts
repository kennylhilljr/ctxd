import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeSignals, type SignalEntry, type SignalRelation, signalLine } from "../../src/journal/signals.js";
import { digestRequestId, isoWeek, parseWhen, timeWindow } from "../../src/journal/time.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");

describe("time filters (SPEC v6 8.2)", () => {
  it("parses ages and ISO dates", () => {
    expect(parseWhen("7d", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseWhen("2W", NOW)).toBe(NOW - 14 * 86_400_000);
    expect(parseWhen("12h", NOW)).toBe(NOW - 12 * 3_600_000);
    expect(parseWhen("2026-10-01", NOW)).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(parseWhen("2026-10-01T08:30:00Z", NOW)).toBe(Date.parse("2026-10-01T08:30:00Z"));
  });

  it.each(["yesterday", "7 days", "-3d", "2026-13-01", "99999d"])("rejects %s with a hint", (v) => {
    expect(() => parseWhen(v, NOW)).toThrow(/Invalid since/);
  });

  it("rejects an until before since", () => {
    expect(() => timeWindow("2d", "7d", NOW)).toThrow(/until is before since/);
    expect(timeWindow("7d", undefined, NOW)).toEqual({ from: NOW - 7 * 86_400_000 });
  });
});

describe("ISO weeks (SPEC v6 11.5)", () => {
  it.each([
    ["2026-10-18T12:00:00Z", "2026-W42"],
    ["2026-01-01T00:00:00Z", "2026-W01"],
    ["2027-01-01T00:00:00Z", "2026-W53"],
    ["2024-12-30T00:00:00Z", "2025-W01"],
    ["2021-01-03T00:00:00Z", "2020-W53"],
  ])("%s is %s", (at, week) => {
    expect(isoWeek(Date.parse(at))).toBe(week);
  });

  it("keys digests by scope and week", () => {
    expect(digestRequestId("s1", NOW)).toBe("digest:s1:2026-W42");
  });
});

const entry = (id: string, over: Partial<SignalEntry> = {}): SignalEntry => ({
  id, scope: "notes", kind: "journal", status: "active", significance: "blocker", createdHlc: `h${id}`, ...over,
});
const rel = (source: string, type: string, target: string, addedHlc: string): SignalRelation => ({
  source, type, target, addedHlc, removed: false,
});

describe("open signals (SPEC v6 11.4)", () => {
  it("opens for active blockers and incidents only", () => {
    const s = computeSignals(
      [entry("1"), entry("2", { significance: "incident" }), entry("3", { significance: "milestone" }), entry("4", { status: "proposed" })],
      [], [],
    );
    expect(s.map((x) => x.entryId)).toEqual(["1", "2"]);
    expect(s.every((x) => x.resolvedHlc === null)).toBe(true);
  });

  it("closes on a resolved link from an active entry, not a proposed one", () => {
    const entries = [entry("1"), entry("fix", { kind: "note", significance: null }), entry("draft", { kind: "note", status: "proposed", significance: null })];
    const proposedOnly = computeSignals(entries, [rel("draft", "resolved", "1", "h5")], []);
    expect(proposedOnly[0]?.resolvedHlc).toBeNull();
    const fixed = computeSignals(entries, [rel("draft", "resolved", "1", "h5"), rel("fix", "resolved", "1", "h7")], []);
    expect(fixed[0]).toMatchObject({ resolvedHlc: "h7", resolvedBy: "fix" });
  });

  it("tracks blocking tasks and flags", () => {
    const entries = [
      entry("a", { kind: "task", significance: null }),
      entry("b", { kind: "task", significance: null, retiredHlc: "h9", status: "archived" }),
      entry("c", { kind: "fact", significance: null }),
    ];
    const s = computeSignals(entries, [rel("a", "blocks", "b", "h3")], [
      { entry: "c", flaggedHlc: "h2" },
      { entry: "c", flaggedHlc: "h4", resolvedHlc: "h6" },
    ]);
    expect(s).toEqual([
      { entryId: "c", scope: "notes", source: "flag", openedHlc: "h2", resolvedHlc: null, resolvedBy: null },
      { entryId: "a", scope: "notes", source: "task", openedHlc: "ha", resolvedHlc: "h9", resolvedBy: "retired" },
    ]);
  });

  it("is independent of input order", () => {
    const entries = [entry("1"), entry("2", { significance: "incident" }), entry("f", { kind: "note", significance: null })];
    const relations = [rel("f", "resolved", "1", "h5"), rel("f", "resolved", "2", "h6"), rel("f", "resolved", "1", "h4")];
    const expected = computeSignals(entries, relations, []);
    fc.assert(
      fc.property(fc.shuffledSubarray(entries, { minLength: 3, maxLength: 3 }), fc.shuffledSubarray(relations, { minLength: 3, maxLength: 3 }), (e, r) => {
        expect(computeSignals(e, r, [])).toEqual(expected);
      }),
    );
  });

  it("formats brief lines with an age", () => {
    expect(signalLine("blocker", 50 * 3_600_000, "waiting on fixtures", "ctxd:notes/01JAB")).toBe(
      "BLOCKER (2d): waiting on fixtures, ctxd:notes/01JAB",
    );
  });
});
