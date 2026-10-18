/** `ctxd ls <ctxd://path>` (SPEC v6 section 4.2, 13): list a ctxd:// folder with summary lines. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir, resolveHumanRequestContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { contextGet } from "../tools/get.js";
import { CtxdError } from "../core/errors.js";

interface GetResult {
  entries: { ref: string; path: string; kind: string; summary: string }[];
  folders?: { path: string; abstract: string; children: { path: string; summary: string }[] }[];
}

export function printLs(db: Database.Database, path: string): number {
  const ctx = resolveHumanRequestContext(db);
  const result = contextGet(ctx, { ids: [path], related: false, max_tokens: 8000 }) as GetResult;

  if (result.folders?.length) {
    const folder = result.folders[0]!;
    console.log(`${folder.path}  (${folder.abstract})`);
    for (const c of folder.children) console.log(`  ${c.path}  ${c.summary}`);
    return 0;
  }
  if (result.entries.length) {
    const e = result.entries[0]!;
    console.log(`${e.path}  (${e.kind})  ${e.summary}`);
    return 0;
  }
  throw new CtxdError("NOT_FOUND", `Nothing found at ${path}`);
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const path = positionals[0] ?? "ctxd://";
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return printLs(db, path);
  } catch (err) {
    console.error(`ctxd ls: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
