/** `ctxd rebuild`: rebuild materialized state and FTS from the event log (SPEC v6 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { rebuild } from "../store/rebuild.js";

export function run(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    rebuild(db);
    console.log("ctxd rebuild: materialized state and FTS rebuilt from the event log.");
    return 0;
  } finally {
    db.close();
  }
}
