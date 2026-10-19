/**
 * Registers each M2 hook event's real handler into HOOK_HANDLERS (src/cli/hook.ts). Imported
 * once, for its side effect, by src/cli/index.ts before any hook event is dispatched.
 */
import { HOOK_HANDLERS, withDeadline, type HookContext, type HookResult } from "../cli/hook.js";
import { isFlagOn } from "../config/flags.js";
import { crashSweep, sweepLeftoverTickets } from "./crashSweep.js";
import { checkPathGuard } from "./pathGuard.js";
import { promptSearchHandler, sessionStartBrief, subagentStartBrief } from "./readMoments.js";
import { postToolUseHandler, preCompactHandler, sessionEndHandler, stopHandler } from "./writeMoments.js";

function guardedPrefixes(ctx: HookContext): string[] {
  const prefixes = [ctx.dataDir, "~/.config/ctxd/"];
  if (ctx.config?.mirror.dir) prefixes.push(ctx.config.mirror.dir);
  return prefixes;
}

/** Wraps a handler so it only runs when `flag` is on; otherwise produces no output, same as having no handler at all. */
function gated<H extends (ctx: HookContext) => HookResult | Promise<HookResult>>(flag: string, handler: H): (ctx: HookContext) => HookResult | Promise<HookResult> {
  return (ctx) => (isFlagOn(ctx.flags, flag) ? handler(ctx) : undefined);
}

HOOK_HANDLERS["session-start"] = async (ctx: HookContext): Promise<HookResult> => {
  if (isFlagOn(ctx.flags, "hooks.crash_sweep")) {
    const graceMinutes = ctx.config?.hooks.crash_grace_minutes ?? 30;
    await withDeadline(300, async () => {
      crashSweep(ctx.db, ctx.nodeId, graceMinutes);
      await sweepLeftoverTickets(ctx.db, ctx.nodeId, ctx.dataDir, graceMinutes, ctx.flags);
    });
  }
  return gated("hooks.session_start", sessionStartBrief)(ctx);
};

HOOK_HANDLERS["subagent-start"] = gated("hooks.session_start", subagentStartBrief);

HOOK_HANDLERS["user-prompt-submit"] = gated("hooks.prompt_search", promptSearchHandler);

HOOK_HANDLERS["pre-tool-use"] = gated("hooks.path_guard", (ctx: HookContext): HookResult => {
  const toolName = ctx.adapter.fields.toolName ? (ctx.input[ctx.adapter.fields.toolName] as string | undefined) : undefined;
  const toolInput = (ctx.adapter.fields.toolInput ? ctx.input[ctx.adapter.fields.toolInput] : undefined) as Record<string, unknown> | undefined;
  if (!toolInput) return undefined;
  const result = checkPathGuard(toolName, toolInput, guardedPrefixes(ctx));
  if (result.blocked) return { block: { reason: result.reason! } };
  return undefined;
});

HOOK_HANDLERS["pre-compact"] = (ctx: HookContext): Promise<HookResult> => preCompactHandler(ctx);

HOOK_HANDLERS["stop"] = (ctx: HookContext): Promise<HookResult> => stopHandler(ctx);

HOOK_HANDLERS["session-end"] = gated("hooks.session_end", sessionEndHandler);

HOOK_HANDLERS["post-tool-use"] = gated("hooks.commit_journal", postToolUseHandler);
