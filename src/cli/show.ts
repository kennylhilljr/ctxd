/** `ctxd show <ref> [--as-of <time>] [--why]` (SPEC v6 section 13, 11.3): show an entry, optionally
 * as of a time; `--why` explains its current importance score and its four parts. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { applyEvent } from "../store/materialize.js";
import { parseRef } from "../model/refs.js";
import { parseWhen } from "../journal/time.js";
import { CtxdError } from "../core/errors.js";
import { entryImportanceDetailed, type EntryRow } from "../tools/support.js";
import { explainImportance } from "../model/importance.js";

/** Replay this entry's events up to (and including) `asOfIso` into a fresh in-memory database, reusing the live materializer so reconstruction can never diverge from it. */
function reconstructAsOf(db: Database.Database, entryId: string, asOfIso: string): EntryRow | undefined {
  const events = db
    .prepare(
      "SELECT event_id, scope_id, op, part, rev, client_id, hlc, payload, prev FROM events WHERE entry_id = ? AND received_at <= ? ORDER BY hlc",
    )
    .all(entryId, asOfIso) as {
    event_id: string;
    scope_id: string;
    op: string;
    part: string;
    rev: string;
    client_id: string;
    hlc: string;
    payload: string;
    prev: string | null;
  }[];
  if (events.length === 0) return undefined;

  const scratch = openDatabase(":memory:", { create: true });
  // A real database enforces entries.scope_id/created_by/updated_by as foreign keys; this
  // scratch instance has no scopes/clients rows at all, only the entry being reconstructed.
  scratch.pragma("foreign_keys = OFF");
  try {
    for (const e of events) {
      if (e.part !== "content" && e.part !== "status" && e.part !== "relations" && e.part !== "claim" && e.part !== "meta") continue;
      applyEvent(
        scratch,
        {
          eventId: e.event_id,
          scopeId: e.scope_id,
          entryId,
          op: e.op,
          part: e.part as "content" | "status" | "relations" | "claim" | "meta",
          rev: e.rev,
          clientId: e.client_id,
          hlc: e.hlc,
          payload: JSON.parse(e.payload) as Record<string, unknown>,
          prev: e.prev ? (JSON.parse(e.prev) as Record<string, unknown>) : null,
        },
        { skipFts: true },
      );
    }
    return scratch.prepare("SELECT * FROM entries WHERE entry_id = ?").get(entryId) as EntryRow | undefined;
  } finally {
    scratch.close();
  }
}

export function printShow(db: Database.Database, ref: string, asOf?: string, why?: boolean): number {
  const parsed = parseRef(ref);
  const id = parsed ? parsed.id : ref;

  const row = asOf
    ? reconstructAsOf(db, id, new Date(parseWhen(asOf, Date.now())).toISOString())
    : (db.prepare("SELECT * FROM entries WHERE entry_id = ?").get(id) as EntryRow | undefined);
  if (!row) throw new CtxdError("NOT_FOUND", asOf ? `Entry did not exist as of ${asOf}: ${ref}` : `Entry not found: ${ref}`);

  const by = (clientId: string) => (db.prepare("SELECT name FROM clients WHERE client_id = ?").get(clientId) as { name: string } | undefined)?.name ?? clientId;
  console.log(`${ref} (${row.kind})${asOf ? ` as of ${asOf}` : ""}`);
  console.log(`  status: ${row.status}  rev: ${row.content_rev}${row.purged_at ? "  PURGED" : ""}`);
  console.log(`  title: ${row.title}`);
  console.log(`  summary: ${row.summary}`);
  console.log(`  created by ${by(row.created_by)} at ${row.created_hlc}`);
  console.log(`  updated by ${by(row.updated_by)} at ${row.updated_hlc}`);
  console.log(`  tags: ${JSON.parse(row.tags).join(", ") || "(none)"}`);
  if (why) printWhy(db, id, asOf);
  console.log("");
  console.log(row.body);
  return 0;
}

/** `--why` (SPEC v6 section 11.3): always the entry's current importance, since recency, reads
 * and inbound links are all live concepts; `--as-of` shows the entry's past content but not a
 * past importance score, which this notes rather than fabricating a number for. */
function printWhy(db: Database.Database, id: string, asOf: string | undefined): void {
  const liveRow = db.prepare("SELECT * FROM entries WHERE entry_id = ?").get(id) as EntryRow | undefined;
  if (!liveRow) return; // purged, or never existed at the current id: nothing to explain
  if (asOf) console.log("  (--why reflects current importance, not the entry's state as of that time)");
  console.log(`  ${explainImportance(entryImportanceDetailed(db, liveRow, Date.now()))}`);
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "as-of": { type: "string" }, why: { type: "boolean" }, "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const ref = positionals[0];
  if (!ref) {
    console.error("Usage: ctxd show <ref> [--as-of <time>] [--why]");
    return 1;
  }
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return printShow(db, ref, values["as-of"], values.why);
  } catch (err) {
    console.error(`ctxd show: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
