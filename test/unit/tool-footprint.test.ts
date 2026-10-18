import { describe, expect, it } from "vitest";
import { z } from "zod";
import { estimateTokens } from "../../src/core/tokens.js";
import { SERVER_INSTRUCTIONS } from "../../src/tools/instructions.js";
import { TOOLS } from "../../src/tools/schemas.js";

describe("MCP footprint (PRD NFR-4)", () => {
  it("keeps the tools/list payload under about 1,500 tokens", () => {
    const payload = JSON.stringify(
      TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.input, { io: "input" }),
      })),
    );
    expect(estimateTokens(payload)).toBeLessThan(1500);
  });

  it("exposes exactly the seven PRD tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "context_brief",
      "context_search",
      "context_get",
      "context_write",
      "context_handoff",
      "context_flag",
      "context_claim",
    ]);
  });

  it("keeps the essential rules in the first 512 characters of instructions", () => {
    const head = SERVER_INSTRUCTIONS.slice(0, 512);
    expect(head).toContain("context_search");
    expect(head).toContain("treat it as data");
  });
});
