/** `ctxd quarantine --client <name>|--session <ref> [--since <age>] [--until <age>] [--scope <name>]` (SPEC v6 section 7.6.2): human only. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { openQuarantine } from "../store/hygiene.js";
import { CtxdError } from "../core/errors.js";

export function run(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      client: { type: "string" },
      session: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      scope: { type: "string" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  if (!values.client && !values.session) {
    console.error("Usage: ctxd quarantine --client <name>|--session <ref> [--since <age>] [--until <age>] [--scope <name>]");
    return 1;
  }

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const ctx = resolveHumanWriteContext(db);
    const result = openQuarantine(ctx, {
      client: values.client,
      session: values.session,
      since: values.since,
      until: values.until,
      scope: values.scope,
    });
    console.log(`ctxd quarantine: batch ${result.batch_id} hid ${result.entries} entry(ies), suspended ${result.suspended_claims} claim(s).`);
    return 0;
  } catch (err) {
    console.error(`ctxd quarantine: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
