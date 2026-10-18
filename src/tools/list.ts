import { z } from "zod";
import { TOOLS } from "./schemas.js";

/** One entry of the MCP tools/list result. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The exact tools/list payload the server serves (SPEC v6 section 8.2): JSON Schema generated from
 * the zod inputs with the `$schema` keyword removed. The footprint test measures this same output.
 */
export function toolDefinitions(): ToolDefinition[] {
  return TOOLS.map((t) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    return { name: t.name, description: t.description, inputSchema };
  });
}
