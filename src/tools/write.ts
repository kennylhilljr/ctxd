import { writeEntry, type WriteContext } from "../store/write.js";
import type { RequestContext } from "../server/context.js";

/** context_write (SPEC v6 sections 4.2, 6, 8.2): a thin wrapper over store/write.ts's writeEntry. */
export function contextWrite(ctx: RequestContext, input: Parameters<typeof writeEntry>[1]): unknown {
  const wctx: WriteContext = { db: ctx.db, clock: ctx.clock, nodeId: ctx.nodeId, clientId: ctx.clientId, assumedPools: ctx.assumedPools, flags: ctx.flags };
  return writeEntry(wctx, input);
}
