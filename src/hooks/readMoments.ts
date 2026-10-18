/**
 * Read moments R1 to R5 (PRD-hooks-v5 section 7.2, SPEC v6 9.1's SessionStart and SubagentStart
 * rows): a brief injected at SessionStart (startup, resume, fork, compact, clear) and
 * SubagentStart. Reuses `assembleBrief` (src/brief/assemble.ts), the same engine behind
 * `ctxd brief` and the context_brief MCP tool, so a hook-injected brief and a manually requested
 * one are always built the same way.
 *
 * Deferred, not silently skipped:
 * - R2's "plus anything that changed since the session last read" needs a per-session read
 *   cursor that nothing writes yet. `assembleBrief`'s `micro` size (used here for resume, fork,
 *   compact and clear) is otherwise exactly what R2 to R4 ask for, including the latest handoff
 *   (R3): its own section 5 includes that regardless of size, with no extra wiring needed here.
 * - R7 (prompt-time hints on UserPromptSubmit) is off by default and needs a per-scope enable
 *   flag with no config surface yet; it has no handler in this slice.
 *
 * assumedPools is resolved from the client's own issued persona token (store/snapshot.ts's
 * resolveAssumedPools), not hardcoded to []: a hook call presents no bearer token to resolve by
 * hash the way the MCP server's auth.ts does, but `ctxd persona issue <client> <pool>` is exactly
 * how a client is meant to be given pool-granted scopes in the first place, hooks included. A
 * client nobody has issued a persona for falls back to [] (SPEC v6 section 3: _me-only), matching
 * a plain token with no persona.
 */
import { HlcClock } from "../core/hlc.js";
import { assembleBrief, type BriefInput } from "../brief/assemble.js";
import { resolveAssumedPools } from "../store/snapshot.js";
import type { RequestContext } from "../server/context.js";
import type { Vendor } from "../core/kinds.js";
import type { HookContext, HookResult } from "../cli/hook.js";

/** SPEC v6 9.1's stated SessionStart fallback text, used for any failure building the brief. */
const UNAVAILABLE_NOTICE = "ctxd unavailable; proceeding without shared context.";

function requestContextOf(ctx: HookContext): RequestContext {
  const row = ctx.db.prepare("SELECT vendor FROM clients WHERE client_id = ?").get(ctx.clientId) as { vendor: Vendor } | undefined;
  return {
    db: ctx.db,
    clock: new HlcClock(ctx.nodeId),
    nodeId: ctx.nodeId,
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    vendor: row?.vendor ?? "other",
    assumedPools: resolveAssumedPools(ctx.db, ctx.clientId),
  };
}

/** The client's own source/trigger field for this SessionStart call, or "startup" when absent. */
function sessionStartVariant(ctx: HookContext): string {
  const source = ctx.adapter.fields.source ? ctx.input[ctx.adapter.fields.source] : undefined;
  const trigger = ctx.adapter.fields.trigger ? ctx.input[ctx.adapter.fields.trigger] : undefined;
  const value = source ?? trigger;
  return typeof value === "string" ? value : "startup";
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…`;
}

function composeBriefText(result: { brief: string; notices: string[] }): string {
  return [result.notices.join(" "), result.brief].filter((s) => s.length > 0).join("\n\n");
}

/** R1 to R4: a brief sized by SessionStart variant, truncated to the configured character budget. */
export function sessionStartBrief(ctx: HookContext): HookResult {
  if (!ctx.scope) return ctx.scopeNotice ? { text: ctx.scopeNotice } : undefined;
  const size: BriefInput["size"] = sessionStartVariant(ctx) === "startup" ? "normal" : "micro";
  const maxChars = ctx.config?.hooks.session_start_max_chars ?? ctx.adapter.limits.sessionStartMaxChars ?? 9500;
  try {
    const result = assembleBrief(requestContextOf(ctx), { scope: ctx.scope, size }) as { brief: string; notices: string[] };
    return { text: truncate(composeBriefText(result), maxChars) };
  } catch {
    return { text: UNAVAILABLE_NOTICE };
  }
}

/** R5: a micro brief so a spawned subagent follows the same conventions; skips silently on failure (its own stated fallback, unlike R1's notice). */
export function subagentStartBrief(ctx: HookContext): HookResult {
  if (!ctx.scope) return undefined;
  try {
    const result = assembleBrief(requestContextOf(ctx), { scope: ctx.scope, size: "micro" }) as { brief: string };
    return result.brief ? { text: result.brief } : undefined;
  } catch {
    return undefined;
  }
}
