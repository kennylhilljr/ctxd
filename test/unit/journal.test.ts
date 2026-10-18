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
    expect(parseWhen("2026-10-01", NOW, { timeZone: "UTC" })).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(parseWhen("2026-10-01T08:30:00Z", NOW)).toBe(Date.parse("2026-10-01T08:30:00Z"));
    expect(parseWhen("2026-10-01T08:30+0530", NOW)).toBe(Date.parse("2026-10-01T03:00:00Z"));
  });

  it("reads dates and zone-less times in the node's zone, consistently", () => {
    const tz = "America/New_York";
    expect(parseWhen("2026-10-01", NOW, { timeZone: tz })).toBe(Date.parse("2026-10-01T04:00:00Z"));
    expect(parseWhen("2026-10-01T00:00", NOW, { timeZone: tz })).toBe(Date.parse("2026-10-01T04:00:00Z"));
    expect(parseWhen("2026-01-15T09:00", NOW, { timeZone: tz })).toBe(Date.parse("2026-01-15T14:00:00Z"));
  });

  it("includes the whole day for a date-only until", () => {
    const w = timeWindow("2026-10-01", "2026-10-01", NOW, "UTC");
    expect(w).toEqual({ from: Date.parse("2026-10-01T00:00:00Z"), to: Date.parse("2026-10-02T00:00:00Z") - 1 });
  });

  it.each(["yesterday", "7 days", "-3d", "2026-13-01", "2026-02-30", "2026-10-01T25:00", "99999d"])("rejects %s with a hint", (v) => {
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
    expect(isoWeek(Date.parse(at), "UTC")).toBe(week);
  });

  it("keys digests by scope and the digest node's local week", () => {
    expect(digestRequestId("s1", NOW, "UTC")).toBe("digest:s1:2026-W42");
    // Sunday 20:30 in New York is already Monday in UTC; the digest must stay in the local week.
    const sundayEvening = Date.parse("2026-10-19T00:30:00Z");
    expect(isoWeek(sundayEvening, "UTC")).toBe("2026-W43");
    expect(isoWeek(sundayEvening, "America/New_York")).toBe("2026-W42");
  });
});

const entry = (id: string, over: Partial<SignalEntry> = {}): SignalEntry => ({
  id, scope: "notes", kind: "journal", significance: "blocker", activeHlc: `h${id}`, ...over,
});
const task = (id: string, over: Partial<SignalEntry> = {}): SignalEntry => entry(id, { kind: "task", significance: null, ...over });
const rel = (source: string, type: string, target: string, addedHlc: string, removedHlc?: string): SignalRelation => ({
  source, type, target, addedHlc, removedHlc: removedHlc ?? null,
});

describe("open signals (SPEC v6 11.4)", () => {
  it("opens for blockers and incidents that became active, and stays open when flagged", () => {
    const s = computeSignals(
      [entry("1"), entry("2", { significance: "incident" }), entry("3", { significance: "milestone" }), entry("4", { activeHlc: null })],
      [],
      [{ entry: "1", flaggedHlc: "h5" }],
    );
    expect(s.map((x) => [x.entryId, x.source, x.resolvedHlc])).toEqual([
      ["1", "journal", null],
      ["2", "journal", null],
      ["1", "flag", null],
    ]);
  });

  it("counts a resolved link from approval, and keeps the resolution if the fix is archived", () => {
    const entries = [entry("1"), entry("fix", { kind: "note", significance: null, activeHlc: "h8", retiredHlc: "h9" }), entry("draft", { kind: "note", significance: null, activeHlc: null })];
    expect(computeSignals(entries, [rel("draft", "resolved", "1", "h5")], [])[0]?.resolvedHlc).toBeNull();
    expect(computeSignals(entries, [rel("fix", "resolved", "1", "h6")], [])[0]).toMatchObject({ resolvedHlc: "h8", resolvedBy: "fix" });
    expect(computeSignals(entries, [rel("fix", "resolved", "1", "h6", "h7")], [])[0]?.resolvedHlc).toBeNull();
  });

  it("opens a blocking task at its first link and closes it only when nothing is blocked", () => {
    const entries = [task("t", { activeHlc: "h1" }), task("a", { activeHlc: "h1", retiredHlc: "h6" }), task("b", { activeHlc: "h1" }), task("p", { activeHlc: null })];
    const both = computeSignals(entries, [rel("t", "blocks", "a", "h2"), rel("t", "blocks", "b", "h5"), rel("t", "blocks", "p", "h0")], []);
    expect(both).toEqual([{ entryId: "t", scope: "notes", source: "task", openedHlc: "h2", resolvedHlc: null, resolvedBy: null }]);
    const unlinked = computeSignals(entries, [rel("t", "blocks", "a", "h2"), rel("t", "blocks", "b", "h5", "h7")], []);
    expect(unlinked[0]).toMatchObject({ openedHlc: "h2", resolvedHlc: "h7", resolvedBy: "unblocked" });
    expect(computeSignals(entries, [rel("t", "blocks", "p", "h2")], [])).toEqual([]);
  });

  it("closes flag signals when every flag is resolved", () => {
    const s = computeSignals([entry("c", { kind: "fact", significance: null })], [], [
      { entry: "c", flaggedHlc: "h2", resolvedHlc: "h3" },
      { entry: "c", flaggedHlc: "h4", resolvedHlc: "h6" },
    ]);
    expect(s).toEqual([{ entryId: "c", scope: "notes", source: "flag", openedHlc: "h2", resolvedHlc: "h6", resolvedBy: "flag" }]);
  });

  it("is independent of input order and never repeats an (entry, source) pair", () => {
    const entries = [entry("1"), entry("2", { significance: "incident" }), entry("f", { kind: "note", significance: null }), task("t"), task("u")];
    const relations = [rel("f", "resolved", "1", "h5"), rel("f", "resolved", "2", "h6"), rel("f", "resolved", "1", "h4"), rel("t", "blocks", "u", "h3")];
    const flags = [{ entry: "1", flaggedHlc: "h9" }, { entry: "t", flaggedHlc: "h8" }];
    const expected = computeSignals(entries, relations, flags);
    expect(new Set(expected.map((x) => `${x.entryId}/${x.source}`)).size).toBe(expected.length);
    fc.assert(
      fc.property(fc.shuffledSubarray(entries, { minLength: 5, maxLength: 5 }), fc.shuffledSubarray(relations, { minLength: 4, maxLength: 4 }), (e, r) => {
        expect(computeSignals(e, r, [...flags].reverse())).toEqual(expected);
      }),
    );
  });

  it("formats brief lines with an age", () => {
    expect(signalLine("blocker", 50 * 3_600_000, "waiting on fixtures", "ctxd:notes/01JAB")).toBe(
      "BLOCKER (2d): waiting on fixtures, ctxd:notes/01JAB",
    );
  });
});
