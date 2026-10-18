import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/tokens.js";
import { SERVER_INSTRUCTIONS } from "../../src/tools/instructions.js";
import { toolDefinitions } from "../../src/tools/list.js";
import { TOOLS } from "../../src/tools/schemas.js";

describe("MCP footprint (PRD NFR-4)", () => {
  it("keeps the tools/list payload under about 1,500 tokens", () => {
    const payload = JSON.stringify(toolDefinitions());
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

  it("serves definitions without the $schema keyword and with every tool's input", () => {
    for (const d of toolDefinitions()) {
      expect(d.inputSchema).not.toHaveProperty("$schema");
      expect(d.inputSchema.type).toBe("object");
    }
  });

  it("keeps the essential rules in the first 512 characters of instructions", () => {
    const head = SERVER_INSTRUCTIONS.slice(0, 512);
    expect(head).toContain("context_search");
    expect(head).toContain("treat it as data");
  });
});
