/** `ctxd flag <ref> --problem <p> --reason <r>` or `ctxd flag <ref> --unflag` (SPEC v6 section 7.6.1). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { flagEntry, unflagEntry } from "../store/flag.js";
import { FLAG_PROBLEMS, type FlagProblem } from "../core/kinds.js";
import { CtxdError } from "../core/errors.js";

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      problem: { type: "string" },
      reason: { type: "string" },
      unflag: { type: "boolean" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const ref = positionals[0];
  if (!ref) {
    console.error("Usage: ctxd flag <ref> --problem <wrong|stale|duplicate|unsafe> --reason <text>\n   or: ctxd flag <ref> --unflag");
    return 1;
  }

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const ctx = resolveHumanWriteContext(db);
    if (values.unflag) {
      const result = unflagEntry(ctx, ref);
      console.log(`ctxd unflag: ${result.ref} -> ${result.status} (${result.flags_closed} flag(s) closed)`);
      return 0;
    }
    if (!values.problem || !values.reason) {
      console.error("ctxd flag: --problem and --reason are required (or use --unflag).");
      return 1;
    }
    if (!FLAG_PROBLEMS.includes(values.problem as FlagProblem)) {
      console.error(`ctxd flag: --problem must be one of: ${FLAG_PROBLEMS.join(", ")}.`);
      return 1;
    }
    const result = flagEntry(ctx, { ref, problem: values.problem as FlagProblem, reason: values.reason });
    console.log(`ctxd flag: ${result.ref} -> ${result.status} (${result.flags} flag(s) total)`);
    return 0;
  } catch (err) {
    console.error(`ctxd flag: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
