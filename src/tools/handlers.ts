import type { RequestContext } from "../server/context.js";
import { CtxdError } from "../core/errors.js";
import { contextBrief } from "./brief.js";
import type { BriefInput } from "../brief/assemble.js";
import { contextSearch } from "./search.js";
import type { SearchInput } from "../search/fts.js";
import { contextGet, type GetInput } from "./get.js";

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
  // The zod contract (tools/schemas.ts) already validated `input` into this exact shape before
  // dispatch (server/mcp.ts); the cast here just bridges the handler registry's generic type.
  context_brief: (ctx, input) => contextBrief(ctx, input as unknown as BriefInput),
  context_search: (ctx, input) => contextSearch(ctx, input as unknown as SearchInput),
  context_get: (ctx, input) => contextGet(ctx, input as unknown as GetInput),
  context_write: notYet("context_write", "M1 slice 6"),
  context_handoff: notYet("context_handoff", "M1 slice 6"),
  context_flag: notYet("context_flag", "M1 slice 6"),
  context_claim: notYet("context_claim", "M1 slice 6"),
};
