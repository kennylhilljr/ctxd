/** `ctxd journal [<scope>] [--day <date>|--since <age>]` (SPEC v6 section 13): read the journal by day or time. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { timeWindow } from "../journal/time.js";
import { entryColumns, hlcToMs, loadScopeInfos, type EntryRow } from "../tools/support.js";
import { CtxdError } from "../core/errors.js";
import type { Status } from "../core/kinds.js";

// Mirrors search/fts.ts's EXCLUDED_STATUSES: retired or hidden statuses never show up as readable content.
const EXCLUDED_STATUSES: ReadonlySet<Status> = new Set(["superseded", "archived", "deleted", "quarantined"]);

export function printJournal(db: Database.Database, scopeArg: string | undefined, day: string | undefined, since: string | undefined): number {
  if (day !== undefined && since !== undefined) {
    throw new CtxdError("VALIDATION", "Use either --day or --since, not both", {}, "day");
  }
  const now = Date.now();
  // --day <date> is a single calendar day: timeWindow's own date-alone-until handling (SPEC v6
  // section 8.2, journal/time.ts's endOfDay) already turns a single date into that day's bounds.
  const window = day !== undefined ? timeWindow(day, day, now) : since !== undefined ? timeWindow(since, undefined, now) : {};

  const scopes = loadScopeInfos(db);
  let scopeIds: string[];
  if (scopeArg !== undefined) {
    const found = scopes.find(({ row }) => row.name === scopeArg);
    if (!found) throw new CtxdError("NOT_FOUND", `Unknown scope "${scopeArg}"`, {}, "scope");
    scopeIds = [found.row.scope_id];
  } else {
    // The human client can read every scope (AGENTS.md: access is default deny for agents, not
    // for the human CLI), so with no scope given this reads across the whole readable set.
    scopeIds = scopes.map(({ row }) => row.scope_id);
  }
  if (scopeIds.length === 0) {
    console.log("No journal entries.");
    return 0;
  }

  const scopeNameById = new Map(scopes.map(({ row }) => [row.scope_id, row.name]));
  const placeholders = scopeIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT ${entryColumns("e")} FROM entries e WHERE e.scope_id IN (${placeholders}) AND e.kind = 'journal' ORDER BY e.created_hlc ASC`)
    .all(...scopeIds) as EntryRow[];

  const filtered = rows.filter((row) => {
    if (EXCLUDED_STATUSES.has(row.status) || row.purged_at) return false;
    // Journal entries use created_hlc for time filtering, not updated_hlc (search/fts.ts's convention).
    const t = hlcToMs(row.created_hlc);
    if (window.from !== undefined && t < window.from) return false;
    if (window.to !== undefined && t > window.to) return false;
    return true;
  });

  if (filtered.length === 0) {
    console.log("No journal entries.");
    return 0;
  }
  for (const row of filtered) {
    const date = new Date(hlcToMs(row.created_hlc)).toISOString().slice(0, 10);
    const scopeName = scopeNameById.get(row.scope_id) ?? row.scope_id;
    const significance = row.significance ?? "routine";
    console.log(`${date}  ${significance.padEnd(11)}  ${scopeName}  ${row.summary}`);
  }
  return 0;
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      day: { type: "string" },
      since: { type: "string" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const scope = positionals[0];

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return printJournal(db, scope, values.day, values.since);
  } catch (err) {
    console.error(`ctxd journal: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
