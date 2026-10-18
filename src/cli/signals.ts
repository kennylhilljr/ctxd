/** `ctxd signals [<scope>]` (SPEC v6 section 11.4, 13): open signals with their age. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { hlcToMs, loadScopeInfos } from "../tools/support.js";
import { formatRef } from "../model/refs.js";
import { CtxdError } from "../core/errors.js";

const DAY_MS = 86_400_000;

/** Mirrors brief/assemble.ts's ageDays: a two-line helper, not worth importing across modules. */
function ageDays(openedAtMs: number, nowMs: number): string {
  const d = Math.floor((nowMs - openedAtMs) / DAY_MS);
  return d < 1 ? "<1d" : `${d}d`;
}

interface SignalRow {
  entry_id: string;
  scope_id: string;
  source: string;
  opened_hlc: string;
  significance: string | null;
  summary: string;
}

export function printSignals(db: Database.Database, scopeArg: string | undefined): number {
  const scopes = loadScopeInfos(db);
  let scopeIds: string[];
  if (scopeArg !== undefined) {
    const found = scopes.find(({ row }) => row.name === scopeArg);
    if (!found) throw new CtxdError("NOT_FOUND", `Unknown scope "${scopeArg}"`, {}, "scope");
    scopeIds = [found.row.scope_id];
  } else {
    // The human client can read every scope, so with no scope given this reads across the whole
    // readable set (AGENTS.md: access is default deny for agents, not for the human CLI).
    scopeIds = scopes.map(({ row }) => row.scope_id);
  }
  if (scopeIds.length === 0) {
    console.log("No open signals.");
    return 0;
  }

  const scopeNameById = new Map(scopes.map(({ row }) => [row.scope_id, row.name]));
  const placeholders = scopeIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.entry_id, s.scope_id, s.source, s.opened_hlc, e.significance, e.summary
       FROM signals s JOIN entries e ON e.entry_id = s.entry_id
       WHERE s.resolved_hlc IS NULL AND s.scope_id IN (${placeholders})
       ORDER BY s.opened_hlc ASC`,
    )
    .all(...scopeIds) as SignalRow[];

  if (rows.length === 0) {
    console.log("No open signals.");
    return 0;
  }
  const now = Date.now();
  for (const row of rows) {
    const label = row.source === "flag" ? "FLAGGED" : (row.significance ?? row.source).toUpperCase();
    const ref = formatRef(scopeNameById.get(row.scope_id) ?? row.scope_id, row.entry_id);
    console.log(`[${row.source}] ${label} (${ageDays(hlcToMs(row.opened_hlc), now)}): ${row.summary}  ${ref}`);
  }
  return 0;
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const scope = positionals[0];

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return printSignals(db, scope);
  } catch (err) {
    console.error(`ctxd signals: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
