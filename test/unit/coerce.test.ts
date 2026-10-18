import { describe, expect, it } from "vitest";
import { ALIAS_TABLES, type AliasTableName, coerceInput, coerceValue } from "../../src/tools/coerce.js";
import { contextClaimInput, contextSearchInput, contextWriteInput } from "../../src/tools/schemas.js";

describe("alias coercion (SPEC v6 8.5)", () => {
  it("maps every alias to a canonical value of its table", () => {
    for (const [name, t] of Object.entries(ALIAS_TABLES)) {
      for (const [alias, target] of Object.entries(t.aliases)) {
        expect(t.values, `${name}.${alias}`).toContain(target);
        expect(coerceValue(name as AliasTableName, alias)).toBe(target);
      }
    }
  });

  it("leaves canonical values unchanged and normalizes case and separators", () => {
    for (const [name, t] of Object.entries(ALIAS_TABLES)) {
      for (const v of t.values) expect(coerceValue(name as AliasTableName, v)).toBe(v);
    }
    expect(coerceValue("kind", "Decisions")).toBe("decision");
    expect(coerceValue("linkType", "derived-from")).toBe("derived_from");
    expect(coerceValue("kind", "Journal Entry")).toBe("journal");
  });

  it("passes unknown values through so validation reports them", () => {
    expect(coerceValue("kind", "opinion")).toBe("opinion");
    expect(coerceValue("kind", 7)).toBe(7);
  });

  it("coerces only enum fields, reports what changed, and then validates", () => {
    const { input, coerced } = coerceInput("context_write", {
      scope: "sample-app",
      kind: "log",
      title: "blocked on fixtures",
      significance: "Blocked",
      links: [{ type: "fixes", ref: "ctxd:sample-app/01JAB" }],
      request_id: "req-00001",
    });
    expect(input.title).toBe("blocked on fixtures");
    expect(coerced).toEqual([
      { field: "kind", from: "log", to: "journal" },
      { field: "significance", from: "Blocked", to: "blocker" },
      { field: "links[0].type", from: "fixes", to: "resolved" },
    ]);
    expect(contextWriteInput.safeParse(input).success).toBe(true);
  });

  it("handles array fields and per-tool action tables", () => {
    const s = coerceInput("context_search", { scope: "notes", query: "x", kinds: ["decisions", "lesson"] });
    expect(s.input.kinds).toEqual(["decision", "lesson"]);
    expect(s.coerced).toHaveLength(1);
    expect(contextSearchInput.safeParse(s.input).success).toBe(true);

    const c = coerceInput("context_claim", { scope: "notes", action: "done" });
    expect(c.input.action).toBe("release");
    expect(contextClaimInput.safeParse(c.input).success).toBe(true);
    expect(coerceInput("context_handoff", { action: "done" }).input.action).toBe("done");
  });
});
