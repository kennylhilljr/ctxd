import { accessLevel, atLeast } from "../access/level.js";
import { loadAccessSnapshot } from "../store/snapshot.js";
import { writeEntry, type WriteContext } from "../store/write.js";
import { CtxdError } from "../core/errors.js";
import { formatRef } from "../model/refs.js";
import { clientInfoOf, clientName, entryColumns, hlcToMs, loadScopeInfos, type EntryRow } from "./support.js";
import type { RequestContext } from "../server/context.js";

/**
 * context_handoff (SPEC v6 sections 4.2, 8.2): "write" composes done/next/open_questions into a
 * handoff entry's body via the normal write path (handoffs are immutable, so this always
 * creates); "latest" reads the latest handoff per client, up to 3, read-level access only.
 */

export interface HandoffInput {
  scope: string;
  action: "write" | "latest";
  done?: string;
  next?: string;
  open_questions?: string;
  session?: string;
  request_id?: string;
}

function composeBody(input: HandoffInput): string {
  const parts: string[] = [];
  if (input.done) parts.push(`Done: ${input.done}`);
  if (input.next) parts.push(`Next: ${input.next}`);
  if (input.open_questions) parts.push(`Open questions: ${input.open_questions}`);
  return parts.join("\n\n");
}

export function contextHandoff(ctx: RequestContext, input: HandoffInput): unknown {
  if (input.action === "write") {
    if (!input.request_id) throw new CtxdError("VALIDATION", "request_id is required to write a handoff", {}, "request_id");
    const body = composeBody(input);
    if (!body) throw new CtxdError("VALIDATION", "At least one of done, next or open_questions is required", {}, "done");
    const wctx: WriteContext = { db: ctx.db, clock: ctx.clock, nodeId: ctx.nodeId, clientId: ctx.clientId, assumedPools: ctx.assumedPools };
    return writeEntry(wctx, {
      scope: input.scope,
      kind: "handoff",
      title: "Handoff",
      body,
      session: input.session,
      request_id: input.request_id,
    } as never);
  }
  return latestHandoffs(ctx, input.scope);
}

function latestHandoffs(ctx: RequestContext, scopeName: string): unknown {
  const { db } = ctx;
  const scopes = loadScopeInfos(db);
  const scope = scopes.find(({ row }) => row.name === scopeName);
  if (!scope) throw new CtxdError("VALIDATION", `Unknown scope "${scopeName}"`, {}, "scope");
  const client = clientInfoOf(ctx);
  const snapshot = loadAccessSnapshot(db);
  if (!atLeast(accessLevel(client, scope.info, snapshot, Date.now(), ctx.assumedPools), "read")) {
    throw new CtxdError("SCOPE_FORBIDDEN", `No read access to "${scopeName}"`, {}, "scope");
  }

  const rows = db
    .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id = ? AND e.kind = 'handoff' AND e.status = 'active' ORDER BY e.updated_hlc DESC`)
    .all(scope.row.scope_id) as EntryRow[];
  const perClient = new Map<string, EntryRow>();
  for (const r of rows) if (!perClient.has(r.updated_by)) perClient.set(r.updated_by, r);
  const picked = [...perClient.values()].slice(0, 3);
  return {
    handoffs: picked.map((r) => ({
      ref: formatRef(scope.row.name, r.entry_id),
      by: clientName(db, r.updated_by),
      summary: r.summary,
      body: r.body,
      updated: new Date(hlcToMs(r.updated_hlc)).toISOString(),
    })),
  };
}
