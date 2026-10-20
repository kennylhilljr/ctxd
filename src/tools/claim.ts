import { handleClaim, type ClaimInput } from "../store/claim.js";
import type { WriteContext } from "../store/write.js";
import type { RequestContext } from "../server/context.js";

/** context_claim (SPEC v6 sections 7.5, 8.2): a thin wrapper over store/claim.ts's handleClaim. */
export function contextClaim(ctx: RequestContext, input: ClaimInput): unknown {
  const wctx: WriteContext = { db: ctx.db, clock: ctx.clock, nodeId: ctx.nodeId, clientId: ctx.clientId, assumedPools: ctx.assumedPools, flags: ctx.flags };
  return handleClaim(wctx, input);
}
