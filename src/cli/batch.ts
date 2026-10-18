/** `ctxd batch show|revert|release <id> [--entry <ref>]` (SPEC v6 sections 7.6.3 and 7.6.4). `show` is read-only; `revert` and `release` are human only. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { releaseBatch, revertBatch, showBatch } from "../store/hygiene.js";
import { CtxdError } from "../core/errors.js";

const SUBCOMMANDS = ["show", "revert", "release"] as const;

export function run(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    console.error("Usage: ctxd batch show <id>\n   or: ctxd batch revert <id> [--entry <ref>]\n   or: ctxd batch release <id> [--entry <ref>]");
    return 1;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      entry: { type: "string" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const batchId = positionals[0];
  if (!batchId) {
    console.error(`Usage: ctxd batch ${sub} <id>${sub === "show" ? "" : " [--entry <ref>]"}`);
    return 1;
  }

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    if (sub === "show") {
      console.log(JSON.stringify(showBatch(db, batchId), null, 2));
      return 0;
    }
    const ctx = resolveHumanWriteContext(db);
    const result = sub === "revert" ? revertBatch(ctx, batchId, values.entry) : releaseBatch(ctx, batchId, values.entry);
    const memberSummary = result.members.map((m) => `${m.entry_id}:${m.outcome ?? "open"}`).join(", ");
    console.log(`ctxd batch ${sub}: ${result.batch_id} -> ${result.state} (${memberSummary})`);
    return 0;
  } catch (err) {
    console.error(`ctxd batch ${sub}: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
