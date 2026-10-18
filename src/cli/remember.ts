/** `ctxd remember "<text>" [--kind preference|convention|fact] [--scope _me]` (SPEC v6 section 13): record memory directly as the human client. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { writeEntry } from "../store/write.js";
import { newId } from "../core/ids.js";
import { CtxdError } from "../core/errors.js";
import type { Kind } from "../core/kinds.js";

const REMEMBER_KINDS: readonly Kind[] = ["preference", "convention", "fact"];

/** Trim to `max` characters at a word boundary, matching the cut style of fsview/paths.ts's slugify. */
export function deriveTitle(text: string, max = 60): string {
  const flat = text.trim().replace(/\s+/g, " ");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${sp > max / 2 ? cut.slice(0, sp) : cut}…`;
}

export function runRemember(db: Database.Database, text: string, kind: Kind, scope: string): number {
  const ctx = resolveHumanWriteContext(db);
  const result = writeEntry(ctx, {
    scope,
    kind,
    title: deriveTitle(text),
    body: text,
    request_id: newId(),
  } as never);
  if ("held" in result) {
    // Unreachable for the human client (SPEC v6 section 6 step 1: human writes are always
    // "write"), kept only so a future access-model change fails loudly instead of silently.
    throw new CtxdError("NOT_ALLOWED", result.message);
  }
  console.log(`ctxd remember: ${result.ref} (${kind}, ${result.status}) in ${scope}`);
  return 0;
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      scope: { type: "string" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const text = positionals[0];
  if (!text) {
    console.error("Usage: ctxd remember \"<text>\" [--kind preference|convention|fact] [--scope _me]");
    return 1;
  }
  const kind = (values.kind ?? "preference") as Kind;
  if (!REMEMBER_KINDS.includes(kind)) {
    console.error(`ctxd remember: --kind must be one of: ${REMEMBER_KINDS.join(", ")}.`);
    return 1;
  }
  const scope = values.scope ?? "_me";

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return runRemember(db, text, kind, scope);
  } catch (err) {
    console.error(`ctxd remember: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
