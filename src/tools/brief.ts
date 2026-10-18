import { assembleBrief, type BriefInput } from "../brief/assemble.js";
import type { RequestContext } from "../server/context.js";

/** context_brief (SPEC v6 sections 4.2, 11.1): a thin wrapper over brief/assemble.ts's assembleBrief. */
export function contextBrief(ctx: RequestContext, input: BriefInput): unknown {
  return assembleBrief(ctx, input);
}
