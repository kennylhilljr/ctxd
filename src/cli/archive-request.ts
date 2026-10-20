import { join } from "node:path";
import { parseArgs } from "node:util";
import { confirmArchiveRequest } from "../mirror/markdown.js";
import { openDatabase } from "../store/db.js";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { yes: { type: "boolean" }, "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const [sub, ref] = positionals;
  if (sub !== "confirm" || !ref) {
    console.error("Usage: ctxd archive-request confirm <ref> [--yes]");
    return 1;
  }
  if (!values.yes) {
    console.log(`About to archive ${ref}. Re-run with --yes to confirm.`);
    return 1;
  }
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    confirmArchiveRequest(resolveHumanWriteContext(db), ref);
    console.log(`ctxd archive-request: archived ${ref}.`);
    return 0;
  } catch (err) {
    console.error(`ctxd archive-request: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
