/**
 * Registers each M2 hook event's real handler into HOOK_HANDLERS (src/cli/hook.ts). Imported
 * once, for its side effect, by src/cli/index.ts before any hook event is dispatched.
 */
import { HOOK_HANDLERS, withDeadline, type HookContext, type HookResult } from "../cli/hook.js";
import { crashSweep } from "./crashSweep.js";
import { checkPathGuard } from "./pathGuard.js";
import { sessionStartBrief, subagentStartBrief } from "./readMoments.js";
import { postToolUseHandler, preCompactHandler, sessionEndHandler, stopHandler } from "./writeMoments.js";

function guardedPrefixes(ctx: HookContext): string[] {
  const prefixes = [ctx.dataDir, "~/.config/ctxd/"];
  if (ctx.config?.mirror.dir) prefixes.push(ctx.config.mirror.dir);
  return prefixes;
}

HOOK_HANDLERS["session-start"] = async (ctx: HookContext): Promise<HookResult> => {
  const graceMinutes = ctx.config?.hooks.crash_grace_minutes ?? 30;
  await withDeadline(300, async () => crashSweep(ctx.db, ctx.nodeId, graceMinutes));
  return sessionStartBrief(ctx);
};

HOOK_HANDLERS["subagent-start"] = (ctx: HookContext): HookResult => subagentStartBrief(ctx);

HOOK_HANDLERS["pre-tool-use"] = (ctx: HookContext): HookResult => {
  const toolName = ctx.adapter.fields.toolName ? (ctx.input[ctx.adapter.fields.toolName] as string | undefined) : undefined;
  const toolInput = (ctx.adapter.fields.toolInput ? ctx.input[ctx.adapter.fields.toolInput] : undefined) as Record<string, unknown> | undefined;
  if (!toolInput) return undefined;
  const result = checkPathGuard(toolName, toolInput, guardedPrefixes(ctx));
  if (result.blocked) return { block: { reason: result.reason! } };
  return undefined;
};

HOOK_HANDLERS["pre-compact"] = (ctx: HookContext): Promise<HookResult> => preCompactHandler(ctx);

HOOK_HANDLERS["stop"] = (ctx: HookContext): Promise<HookResult> => stopHandler(ctx);

HOOK_HANDLERS["session-end"] = (ctx: HookContext): HookResult => sessionEndHandler(ctx);

HOOK_HANDLERS["post-tool-use"] = (ctx: HookContext): HookResult => postToolUseHandler(ctx);
