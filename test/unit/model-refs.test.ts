import { describe, expect, it } from "vitest";
import { findRefs, formatRef, parseRef } from "../../src/model/refs.js";

const ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";

describe("entry references (SPEC v3 4.1)", () => {
  it("formats and parses references", () => {
    const ref = formatRef("ctxd", ID);
    expect(ref).toBe(`ctxd:ctxd/${ID}`);
    expect(parseRef(ref)).toEqual({ scope: "ctxd", id: ID });
    expect(parseRef(ID)).toEqual({ scope: null, id: ID });
    expect(formatRef("_me", ID)).toBe(`ctxd:_me/${ID}`);
  });

  it("accepts reserved-namespace and @-containing scope names (regression: holding scopes and client-named scopes were rejected)", () => {
    expect(formatRef("_me.pool-dev", ID)).toBe(`ctxd:_me.pool-dev/${ID}`);
    expect(formatRef("_hold.codex@laptop", ID)).toBe(`ctxd:_hold.codex@laptop/${ID}`);
    expect(parseRef(`ctxd:_hold.codex@laptop/${ID}`)).toEqual({ scope: "_hold.codex@laptop", id: ID });
  });

  it("rejects malformed references", () => {
    expect(parseRef("ctxd:Bad Scope/" + ID)).toBeNull();
    expect(parseRef("ctxd:ctxd/notaulid")).toBeNull();
    expect(() => formatRef("ctxd", "short")).toThrow();
  });

  it("finds references in free text such as commit messages", () => {
    const text = `Implements ctxd:ctxd/${ID} and relates to ctxd:_me/${ID}.`;
    expect(findRefs(text)).toEqual([
      { scope: "ctxd", id: ID },
      { scope: "_me", id: ID },
    ]);
  });
});
