import type { RequestContext } from "../server/context.js";
import { CtxdError } from "../core/errors.js";

/**
 * One MCP tool's implementation: validated input in, a JSON-serializable result out (or it
 * throws a CtxdError, which the server turns into the error envelope, SPEC v6 section 8.5).
 */
export type ToolHandler = (ctx: RequestContext, input: Record<string, unknown>) => unknown;

function notYet(toolName: string, milestone: string): ToolHandler {
  return () => {
    throw new CtxdError("VALIDATION", `${toolName} is not implemented yet (planned for ${milestone}).`);
  };
}

/** Registry the server dispatches `tools/call` through. Slices 5 and 6 replace these entries. */
export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  context_brief: notYet("context_brief", "M1 slice 5"),
  context_search: notYet("context_search", "M1 slice 5"),
  context_get: notYet("context_get", "M1 slice 5"),
  context_write: notYet("context_write", "M1 slice 6"),
  context_handoff: notYet("context_handoff", "M1 slice 6"),
  context_flag: notYet("context_flag", "M1 slice 6"),
  context_claim: notYet("context_claim", "M1 slice 6"),
};
