import { describe, expect, it } from "vitest";
import { makeRev, newId, revVersion } from "../../src/core/ids.js";

describe("makeRev", () => {
  it("parses back its own version with revVersion", () => {
    const rev = makeRev(3, newId());
    expect(revVersion(rev)).toBe(3);
  });

  it("regression: two event ids minted back to back at the same version never collide", () => {
    // Found while testing M3 slice 3's conflict policies: makeRev used to take a ULID's first 10
    // characters, which are a millisecond timestamp, not random, so two events created in the
    // same millisecond (the common case for two synchronous calls like these) produced the
    // identical rev string at the same version, and the conflict-policy lookup that is keyed on
    // rev (src/store/materialize.ts's eventHoldingRev) could no longer tell them apart.
    const revs = new Set<string>();
    for (let i = 0; i < 200; i++) revs.add(makeRev(2, newId()));
    expect(revs.size).toBe(200);
  });
});
