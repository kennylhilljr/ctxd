import { flagEntry, type FlagInput } from "../store/flag.js";
import type { WriteContext } from "../store/write.js";
import type { RequestContext } from "../server/context.js";

/** context_flag (SPEC v6 sections 7.6.1, 8.2): a thin wrapper over store/flag.ts's flagEntry. */
export function contextFlag(ctx: RequestContext, input: FlagInput): unknown {
  const wctx: WriteContext = { db: ctx.db, clock: ctx.clock, nodeId: ctx.nodeId, clientId: ctx.clientId, assumedPools: ctx.assumedPools };
  return flagEntry(wctx, input);
}
