/**
 * `ctxd scope rollback <scope> --to <time>` (SPEC v8 7.6.5): all events in the scope at or after
 * `<time>`, from every source, selected and reverted in one step. SPEC's own wording ("selected
 * and reverted as in 7.6.2 and 7.6.3") is reused literally: the selection and batch-member
 * bookkeeping mirror `openQuarantine`'s (minus the quarantine-hide step and claim suspension,
 * which rollback has no use for since it reverts immediately rather than waiting for a human
 * decision), and the actual revert is `revertBatch` itself, already selector-agnostic (it never
 * requires a client or session; `resolveSelectorClientId` returns `undefined` and every source's
 * edits in the window are then eligible, exactly what "from every source" needs). This batch-open
 * step writes no event of its own, only `batches`/`batch_members` rows, so unlike
 * `openQuarantine` it never needs an origin-seq allocator; `revertBatch` allocates its own
 * sequence numbers for whatever events it appends.
 */
import type Database from "better-sqlite3";
import { newId } from "../core/ids.js";
import { decodeHlc } from "../core/hlc.js";
import { CtxdError } from "../core/errors.js";
import { canonicalJson } from "./idempotency.js";
import { formatRef } from "../model/refs.js";
import { timeWindow } from "../journal/time.js";
import { loadScopeByName } from "./snapshot.js";
import { isWithin, requireHuman, revertBatch, type SelEvent, type BatchActionResult } from "./hygiene.js";
import type { WriteContext } from "./write.js";

export interface RollbackPreview {
  scope: string;
  since: string;
  entries: { ref: string; title: string }[];
}

function selectCandidates(db: Database.Database, scopeId: string, fromMs: number, toMs: number): SelEvent[] {
  const rows = db
    .prepare("SELECT event_id, scope_id, entry_id, hlc, client_id, session_ref, part, op, rev, prev FROM events WHERE scope_id = ? AND part IN ('content','relations','status')")
    .all(scopeId) as SelEvent[];
  return rows.filter((e) => isWithin(decodeHlc(e.hlc).physical, fromMs, toMs));
}

/** Read-only: entry count and a diff summary, as SPEC 7.6.5 requires before confirmation. */
export function previewRollback(db: Database.Database, scopeName: string, since: string): RollbackPreview {
  const scope = loadScopeByName(db, scopeName);
  if (!scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${scopeName}`, {}, "scope");
  const now = Date.now();
  const { from } = timeWindow(since, undefined, now);

  const selected = selectCandidates(db, scope.id, from!, now);
  const entryIds = [...new Set(selected.map((e) => e.entry_id))];
  const entries = entryIds.map((id) => {
    const row = db.prepare("SELECT title FROM entries WHERE entry_id = ?").get(id) as { title: string } | undefined;
    return { ref: formatRef(scopeName, id), title: row?.title ?? "(gone)" };
  });

  return { scope: scopeName, since: new Date(from!).toISOString(), entries };
}

export interface RollbackResult {
  batch_id: string;
  entries: number;
  reverted: number;
  conflicted: number;
}

/** Human only (SPEC's access table: rollback is listed alongside revert/release/purge as human only). */
export function executeRollback(ctx: WriteContext, scopeName: string, since: string): RollbackResult {
  const { db } = ctx;
  requireHuman(db, ctx.clientId, "scope rollback");
  const scope = loadScopeByName(db, scopeName);
  if (!scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${scopeName}`, {}, "scope");

  const openedAt = Date.now();
  const { from: fromMs } = timeWindow(since, undefined, openedAt);
  const toMs = openedAt;

  const selected = selectCandidates(db, scope.id, fromMs!, toMs);
  if (selected.length === 0) throw new CtxdError("NOT_FOUND", "No events matched this window", {}, "since");

  const byEntry = new Map<string, SelEvent[]>();
  for (const e of selected) {
    const list = byEntry.get(e.entry_id);
    if (list) list.push(e);
    else byEntry.set(e.entry_id, [e]);
  }

  const batchId = newId();
  db.transaction(() => {
    const createdHlc = ctx.clock.tick();
    const storedSelector = { since: new Date(fromMs!).toISOString(), until: new Date(toMs).toISOString(), scope: scopeName };
    db.prepare("INSERT INTO batches (batch_id, kind, selector, state, created_by, created_hlc) VALUES (?, 'rollback', ?, 'open', ?, ?)").run(
      batchId,
      canonicalJson(storedSelector),
      ctx.clientId,
      createdHlc,
    );

    for (const [entryId, events] of byEntry) {
      const createRow = db.prepare("SELECT hlc FROM events WHERE entry_id = ? AND op = 'create'").get(entryId) as { hlc: string } | undefined;
      const createdInBatch = createRow ? isWithin(decodeHlc(createRow.hlc).physical, fromMs, toMs) : false;
      const firstEvent = events.reduce((min, e) => (e.hlc < min.hlc ? e : min));
      db.prepare("INSERT INTO batch_members (batch_id, entry_id, first_event, created_in_batch, outcome) VALUES (?, ?, ?, ?, NULL)").run(
        batchId,
        entryId,
        firstEvent.event_id,
        createdInBatch ? 1 : 0,
      );
    }
  })();

  const outcome: BatchActionResult = revertBatch(ctx, batchId);
  const reverted = outcome.members.filter((m) => m.outcome === "reverted").length;
  const conflicted = outcome.members.filter((m) => m.outcome === "conflict").length;
  return { batch_id: batchId, entries: byEntry.size, reverted, conflicted };
}
