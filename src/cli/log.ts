/** `ctxd log "<text>" [--significance <s>] [--scope <name>] [--resolves <ref>]` (SPEC v6 section 13): add a journal entry. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { writeEntry } from "../store/write.js";
import { newId } from "../core/ids.js";
import { CtxdError } from "../core/errors.js";
import { parseRef } from "../model/refs.js";
import { SIGNIFICANCES, type Significance } from "../core/kinds.js";
import { deriveTitle } from "./remember.js";

/** Journal body cap (tools/schemas.ts's contextWriteInput refinement, SPEC v6 section 4.3). */
const JOURNAL_BODY_MAX = 1000;

export function runLog(db: Database.Database, text: string, significance: Significance, scope: string, resolves?: string): number {
  if (text.length > JOURNAL_BODY_MAX) {
    throw new CtxdError("VALIDATION", `journal body is at most ${JOURNAL_BODY_MAX.toLocaleString()} characters (got ${text.length})`, {}, "body");
  }
  let links: { type: "resolved"; ref: string }[] | undefined;
  if (resolves !== undefined) {
    if (!parseRef(resolves)) throw new CtxdError("VALIDATION", `Invalid --resolves reference: ${resolves}`, {}, "resolves");
    links = [{ type: "resolved", ref: resolves }];
  }

  const ctx = resolveHumanWriteContext(db);
  const result = writeEntry(ctx, {
    scope,
    kind: "journal",
    title: deriveTitle(text, 200),
    body: text,
    significance,
    links,
    request_id: newId(),
  } as never);
  if ("held" in result) {
    // Unreachable for the human client (SPEC v6 section 6 step 1: human writes are always
    // "write"), kept only so a future access-model change fails loudly instead of silently.
    throw new CtxdError("NOT_ALLOWED", result.message);
  }
  console.log(`ctxd log: ${result.ref} (${significance}) in ${scope}`);
  return 0;
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      significance: { type: "string" },
      scope: { type: "string" },
      resolves: { type: "string" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const text = positionals[0];
  if (!text) {
    console.error('Usage: ctxd log "<text>" [--significance <s>] --scope <name> [--resolves <ref>]');
    return 1;
  }
  const significance = (values.significance ?? "routine") as Significance;
  if (!SIGNIFICANCES.includes(significance)) {
    console.error(`ctxd log: --significance must be one of: ${SIGNIFICANCES.join(", ")}.`);
    return 1;
  }
  // Journal entries are scope-specific, not _me (SPEC v6 section 4.3): unlike remember, there is
  // no sensible global default, so --scope is required.
  if (!values.scope) {
    console.error("ctxd log: --scope is required.");
    return 1;
  }

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return runLog(db, text, significance, values.scope, values.resolves);
  } catch (err) {
    console.error(`ctxd log: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
