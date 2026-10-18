/**
 * Registers each M2 hook event's real handler into HOOK_HANDLERS (src/cli/hook.ts). Imported
 * once, for its side effect, by src/cli/index.ts before any hook event is dispatched. Later M2
 * slices (crash sweep, read moments, write moments) add their own registrations here.
 */
import { HOOK_HANDLERS, type HookContext, type HookResult } from "../cli/hook.js";
import { checkPathGuard } from "./pathGuard.js";

function guardedPrefixes(ctx: HookContext): string[] {
  const prefixes = [ctx.dataDir, "~/.config/ctxd/"];
  if (ctx.config?.mirror.dir) prefixes.push(ctx.config.mirror.dir);
  return prefixes;
}

HOOK_HANDLERS["pre-tool-use"] = (ctx: HookContext): HookResult => {
  const toolName = ctx.adapter.fields.toolName ? (ctx.input[ctx.adapter.fields.toolName] as string | undefined) : undefined;
  const toolInput = (ctx.adapter.fields.toolInput ? ctx.input[ctx.adapter.fields.toolInput] : undefined) as Record<string, unknown> | undefined;
  if (!toolInput) return undefined;
  const result = checkPathGuard(toolName, toolInput, guardedPrefixes(ctx));
  if (result.blocked) return { block: { reason: result.reason! } };
  return undefined;
};
