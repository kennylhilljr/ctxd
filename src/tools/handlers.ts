import type { RequestContext } from "../server/context.js";
import { contextBrief } from "./brief.js";
import type { BriefInput } from "../brief/assemble.js";
import { contextSearch } from "./search.js";
import type { SearchInput } from "../search/fts.js";
import { contextGet, type GetInput } from "./get.js";
import { contextWrite } from "./write.js";
import type { contextWriteInput } from "./schemas.js";
import type { z } from "zod";
import { contextHandoff, type HandoffInput } from "./handoff.js";
import { contextFlag } from "./flag.js";
import type { FlagInput } from "../store/flag.js";
import { contextClaim } from "./claim.js";
import type { ClaimInput } from "../store/claim.js";

/**
 * One MCP tool's implementation: validated input in, a JSON-serializable result out (or it
 * throws a CtxdError, which the server turns into the error envelope, SPEC v6 section 8.5).
 */
export type ToolHandler = (ctx: RequestContext, input: Record<string, unknown>) => unknown | Promise<unknown>;

/** Registry the server dispatches `tools/call` through. All seven M1 tools are live. */
export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // The zod contract (tools/schemas.ts) already validated `input` into this exact shape before
  // dispatch (server/mcp.ts); the cast here just bridges the handler registry's generic type.
  context_brief: (ctx, input) => contextBrief(ctx, input as unknown as BriefInput),
  context_search: (ctx, input) => contextSearch(ctx, input as unknown as SearchInput),
  context_get: (ctx, input) => contextGet(ctx, input as unknown as GetInput),
  context_write: (ctx, input) => contextWrite(ctx, input as unknown as z.infer<typeof contextWriteInput>),
  context_handoff: (ctx, input) => contextHandoff(ctx, input as unknown as HandoffInput),
  context_flag: (ctx, input) => contextFlag(ctx, input as unknown as FlagInput),
  context_claim: (ctx, input) => contextClaim(ctx, input as unknown as ClaimInput),
};
