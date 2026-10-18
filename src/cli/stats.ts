/** `ctxd stats` (SPEC v6 section 8.5, 13): response sizes per tool and client. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";

interface StatsRow {
  tool: string;
  client: string;
  calls: number;
  avg_tokens: number;
  max_tokens: number;
  truncated: number;
}

export function printStats(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT m.tool AS tool, c.name AS client, COUNT(*) AS calls,
              CAST(ROUND(AVG(m.est_tokens)) AS INTEGER) AS avg_tokens, MAX(m.est_tokens) AS max_tokens,
              SUM(m.truncated) AS truncated
       FROM tool_metrics m JOIN clients c ON c.client_id = m.client_id
       GROUP BY m.tool, c.name ORDER BY m.tool, c.name`,
    )
    .all() as StatsRow[];

  if (rows.length === 0) {
    console.log("No tool calls recorded yet.");
    return 0;
  }
  console.log("tool                 client               calls  avg_tokens  max_tokens  truncated");
  for (const r of rows) {
    console.log(
      `${r.tool.padEnd(20)} ${r.client.padEnd(20)} ${String(r.calls).padStart(5)}  ${String(r.avg_tokens).padStart(10)}  ${String(r.max_tokens).padStart(10)}  ${String(r.truncated).padStart(9)}`,
    );
  }
  return 0;
}

export function run(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return printStats(db);
  } finally {
    db.close();
  }
}
