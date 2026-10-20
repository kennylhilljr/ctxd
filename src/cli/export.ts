import { parseArgs } from "node:util";
import { join } from "node:path";
import { openDatabase } from "../store/db.js";
import { resolveDataDir } from "./common.js";
import { exportMarkdown } from "../mirror/markdown.js";

export function run(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { markdown: { type: "boolean" }, output: { type: "string" }, scope: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } }, strict: true });
  if (!values.markdown || !values.output) { console.error("Usage: ctxd export --markdown --output <dir> [--scope <name>]"); return 1; }
  const db = openDatabase(join(resolveDataDir({ dataDir: values["data-dir"], configPath: values.config }), "ctxd.db"));
  try {
    const result = exportMarkdown(db, values.output, values.scope);
    console.log(`ctxd export: ${result.written} Markdown file(s) written to ${values.output}.`);
    return 0;
  } finally { db.close(); }
}
