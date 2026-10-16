import { describe, expect, it } from "vitest";
import { compareHlc, decodeHlc, encodeHlc, HlcClock } from "../../src/core/hlc.js";

describe("HLC", () => {
  it("round-trips encoding", () => {
    const value = encodeHlc({ physical: 1_760_000_000_000, counter: 7, node: "NODEA" });
    expect(decodeHlc(value)).toEqual({ physical: 1_760_000_000_000, counter: 7, node: "NODEA" });
  });

  it("is monotonic when the wall clock stalls or goes backwards", () => {
    let wall = 1000;
    const clock = new HlcClock("A", () => wall);
    const a = clock.tick();
    wall = 900;
    const b = clock.tick();
    const c = clock.tick();
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
  });

  it("orders a received event after the remote timestamp", () => {
    const local = new HlcClock("A", () => 1000);
    const remote = new HlcClock("B", () => 5000).tick();
    const after = local.receive(remote);
    expect(compareHlc(remote, after)).toBe(-1);
    expect(compareHlc(after, local.tick())).toBe(-1);
  });

  it("sorts lexicographically by time across nodes", () => {
    const early = encodeHlc({ physical: 10, counter: 0, node: "ZZZ" });
    const late = encodeHlc({ physical: 11, counter: 0, node: "AAA" });
    expect([late, early].sort()).toEqual([early, late]);
  });
});
