/** `ctxd brief <scope> [--size micro|normal|full]` (SPEC v6 section 11.1): print a brief for a scope. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir, resolveHumanRequestContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { assembleBrief, type BriefInput } from "../brief/assemble.js";
import { CtxdError } from "../core/errors.js";

export function printBrief(db: Database.Database, scope: string, size: BriefInput["size"]): number {
  const ctx = resolveHumanRequestContext(db);
  const result = assembleBrief(ctx, { scope, size }) as { scope: string; as_of: string; node: string; notices: string[]; brief: string };
  console.log(`Scope: ${result.scope} | as-of ${result.as_of} | node ${result.node}`);
  if (result.notices.length) console.log(`Notices: ${result.notices.join(" ")}`);
  console.log("");
  console.log(result.brief);
  return 0;
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { size: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const scope = positionals[0];
  if (!scope) {
    console.error("Usage: ctxd brief <scope> [--size micro|normal|full]");
    return 1;
  }
  const size = (values.size ?? "normal") as BriefInput["size"];
  if (size !== "micro" && size !== "normal" && size !== "full") {
    console.error("ctxd brief: --size must be one of: micro, normal, full.");
    return 1;
  }

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return printBrief(db, scope, size);
  } catch (err) {
    console.error(`ctxd brief: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
