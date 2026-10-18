/** `ctxd history <ref>` (SPEC v6 section 13): show every change to an entry, from the event log. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { parseRef } from "../model/refs.js";
import { CtxdError } from "../core/errors.js";

interface EventRow {
  event_id: string;
  op: string;
  part: string;
  hlc: string;
  client_id: string;
  payload: string;
}

export function printHistory(db: Database.Database, ref: string): number {
  const parsed = parseRef(ref);
  const id = parsed ? parsed.id : ref;
  const rows = db.prepare("SELECT event_id, op, part, hlc, client_id, payload FROM events WHERE entry_id = ? ORDER BY hlc").all(id) as EventRow[];
  if (rows.length === 0) throw new CtxdError("NOT_FOUND", `No events found for ${ref}`);

  for (const r of rows) {
    const client = (db.prepare("SELECT name FROM clients WHERE client_id = ?").get(r.client_id) as { name: string } | undefined)?.name ?? r.client_id;
    const payload = JSON.parse(r.payload) as Record<string, unknown>;
    const summary = payload.purged === true ? "(purged)" : summarizePayload(r.op, payload);
    console.log(`${r.hlc}  ${r.op.padEnd(10)} ${r.part.padEnd(10)} by ${client.padEnd(20)} ${summary}`);
  }
  return 0;
}

function summarizePayload(op: string, payload: Record<string, unknown>): string {
  switch (op) {
    case "create":
    case "update":
      return JSON.stringify({ title: payload.title, summary: payload.summary }).slice(0, 120);
    case "status":
      return JSON.stringify({ status: payload.status });
    case "flag":
      return JSON.stringify({ problem: payload.problem, reason: payload.reason });
    case "relate":
      return JSON.stringify({ type: payload.type, ref: payload.ref });
    case "claim":
      return JSON.stringify({ holder: payload.holder, ttl_minutes: payload.ttl_minutes });
    case "release":
      return JSON.stringify({ changed_files: payload.changed_files, drift: payload.drift });
    case "purge":
      return JSON.stringify({ reason: payload.reason });
    default:
      return JSON.stringify(payload).slice(0, 120);
  }
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const ref = positionals[0];
  if (!ref) {
    console.error("Usage: ctxd history <ref>");
    return 1;
  }
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return printHistory(db, ref);
  } catch (err) {
    console.error(`ctxd history: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
