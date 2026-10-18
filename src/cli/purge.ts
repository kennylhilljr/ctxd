/** `ctxd purge <ref> --reason <text> [--yes]` (SPEC v6 section 7.6.6): human only, confirmed. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { previewPurge, purgeEntry } from "../store/purge.js";
import { CtxdError } from "../core/errors.js";

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      reason: { type: "string" },
      yes: { type: "boolean" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const ref = positionals[0];
  if (!ref || !values.reason) {
    console.error("Usage: ctxd purge <ref> --reason <text> [--yes]");
    return 1;
  }

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const preview = previewPurge(db, ref);
    if (!values.yes) {
      console.log(`About to permanently erase this entry's content everywhere:`);
      console.log(`  ${preview.ref} (${preview.kind}) in ${preview.scope}: "${preview.title}"`);
      console.log(`Reason: ${values.reason}`);
      console.log(`This cannot be undone. Re-run with --yes to confirm.`);
      return 1;
    }
    const ctx = resolveHumanWriteContext(db);
    const result = purgeEntry(ctx, ref, values.reason);
    console.log(`ctxd purge: ${result.ref} erased at ${result.purged_at}.`);
    return 0;
  } catch (err) {
    console.error(`ctxd purge: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
