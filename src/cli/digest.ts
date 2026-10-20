/** `ctxd digest [<scope>] [--week <id>]` (SPEC v8 11.5): prints an already-written digest, or assembles and writes a new one. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { loadScopeByName } from "../store/snapshot.js";
import { assembleDigest, digestAlreadyWritten, lastCompletedWeek, scopesWithActivity, writeDigest } from "../journal/digest.js";
import { isoWeekBounds } from "../core/dates.js";
import { CtxdError } from "../core/errors.js";
import type { WriteContext } from "../store/write.js";

const WEEK_ID = /^\d{4}-W\d{2}$/;

function digestFor(ctx: WriteContext, scopeId: string, scopeName: string, weekId: string): { ref: string | null; body: string } {
  const { db, clientId } = ctx;
  if (digestAlreadyWritten(db, clientId, scopeId, weekId)) {
    const existing = db
      .prepare(
        "SELECT entry_id, body FROM entries WHERE scope_id = ? AND kind = 'journal' AND tags LIKE ? ORDER BY created_hlc DESC LIMIT 1",
      )
      .get(scopeId, `%"${weekId}"%`) as { entry_id: string; body: string } | undefined;
    return { ref: existing?.entry_id ?? null, body: existing?.body ?? assembleDigest(db, scopeId, scopeName, weekId).body };
  }
  const result = writeDigest(ctx, scopeId, scopeName, weekId);
  return { ref: result.ref, body: result.body };
}

export function runDigest(db: Database.Database, scopeName: string | undefined, weekId: string): number {
  if (!WEEK_ID.test(weekId)) throw new CtxdError("VALIDATION", `--week must look like 2026-W42, got "${weekId}"`, {}, "week");
  const ctx = resolveHumanWriteContext(db);

  if (scopeName) {
    const scope = loadScopeByName(db, scopeName);
    if (!scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${scopeName}`, {}, "scope");
    const { ref, body } = digestFor(ctx, scope.id, scopeName, weekId);
    console.log(`ctxd digest: ${scopeName} (${weekId})${ref ? ` ${ref}` : ""}`);
    console.log(body);
    return 0;
  }

  // No scope named: only scopes with at least one new event that week get a digest (SPEC 11.5).
  const { from, to } = isoWeekBounds(weekId);
  const scopes = scopesWithActivity(db, from, to);
  if (scopes.length === 0) {
    console.log(`ctxd digest: no scope had activity in ${weekId}.`);
    return 0;
  }
  for (const scope of scopes) {
    const { ref, body } = digestFor(ctx, scope.id, scope.name, weekId);
    console.log(`ctxd digest: ${scope.name} (${weekId})${ref ? ` ${ref}` : ""}`);
    console.log(body);
    console.log("");
  }
  return 0;
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { week: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return runDigest(db, positionals[0], values.week ?? lastCompletedWeek(Date.now()));
  } catch (err) {
    console.error(`ctxd digest: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
