import { writeEntry, type WriteContext } from "../store/write.js";
import type { RequestContext } from "../server/context.js";
import { isFlagOn } from "../config/flags.js";
import { scheduleSkillSync } from "../skills/sync.js";
import { spawnWorker } from "../hooks/writeMoments.js";

/**
 * context_write (SPEC v6 sections 4.2, 6, 8.2): a thin wrapper over store/write.ts's writeEntry,
 * plus W5.4's automatic skill sync trigger: a write to a skill entry, with skills.native_sync on,
 * schedules a sync through the detached worker rather than running it here. Harmless to schedule
 * for a write that leaves the skill `proposed` (syncSkillsForClient only ever selects `active`
 * skills), so this triggers on kind alone, not on the resulting status. `spawnFn` is overridable
 * only for tests, same as `sessionEndHandler`.
 */
export async function contextWrite(ctx: RequestContext, input: Parameters<typeof writeEntry>[1], spawnFn: typeof spawnWorker = spawnWorker): Promise<unknown> {
  const wctx: WriteContext = { db: ctx.db, clock: ctx.clock, nodeId: ctx.nodeId, clientId: ctx.clientId, assumedPools: ctx.assumedPools, flags: ctx.flags };
  const result = writeEntry(wctx, input);
  if (!("held" in result) && input.kind === "skill" && isFlagOn(ctx.flags, "skills.native_sync") && ctx.dataDir) {
    await scheduleSkillSync(ctx.dataDir, ctx.configPath ?? "", spawnFn);
  }
  return result;
}
