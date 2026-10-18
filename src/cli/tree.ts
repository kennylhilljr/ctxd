/** `ctxd tree <ctxd://path> [--depth N]` (SPEC v6 section 4.2, 13): show the ctxd:// tree to a depth. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir, resolveHumanRequestContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { contextGet } from "../tools/get.js";
import type { RequestContext } from "../server/context.js";
import { CtxdError } from "../core/errors.js";

interface GetResult {
  entries: { path: string }[];
  folders?: { path: string; children: { path: string }[] }[];
}

const DEFAULT_DEPTH = 2;

/**
 * Print every child's line unconditionally, before attempting to recurse into it -- a child
 * folder contextGet can't resolve yet (e.g. journal/, deferred past M1 per get.ts's own note)
 * must still show up as a line, not silently vanish because its own recursive call found nothing.
 */
function walkChildren(ctx: RequestContext, children: readonly { path: string }[], maxDepth: number, level: number): void {
  const indent = "  ".repeat(level);
  for (const c of children) {
    console.log(`${indent}${c.path}`);
    if (c.path.endsWith("/") && level < maxDepth) walk(ctx, c.path, maxDepth, level + 1);
  }
}

function walk(ctx: RequestContext, path: string, maxDepth: number, level: number): void {
  const result = contextGet(ctx, { ids: [path], related: false, max_tokens: 8000 }) as GetResult;
  if (!result.folders?.length) return; // not a folder, or not one contextGet can resolve yet; its line was already printed by the caller
  const folder = result.folders[0]!;
  if (level >= maxDepth) {
    if (folder.children.length) console.log(`${"  ".repeat(level + 1)}... (${folder.children.length} items, increase --depth)`);
    return;
  }
  walkChildren(ctx, folder.children, maxDepth, level + 1);
}

export function printTree(db: Database.Database, path: string, depth: number): number {
  const ctx = resolveHumanRequestContext(db);
  const result = contextGet(ctx, { ids: [path], related: false, max_tokens: 8000 }) as GetResult;
  if (result.entries.length) {
    console.log(result.entries[0]!.path);
    return 0;
  }
  if (!result.folders?.length) throw new CtxdError("NOT_FOUND", `Nothing found at ${path}`);
  const folder = result.folders[0]!;
  console.log(folder.path);
  if (depth > 0) walkChildren(ctx, folder.children, depth, 1);
  else if (folder.children.length) console.log(`  ... (${folder.children.length} items, increase --depth)`);
  return 0;
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { depth: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const path = positionals[0] ?? "ctxd://";
  const depth = values.depth ? Number(values.depth) : DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < 0) {
    console.error("ctxd tree: --depth must be a non-negative integer.");
    return 1;
  }
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return printTree(db, path, depth);
  } catch (err) {
    console.error(`ctxd tree: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
