/** `ctxd grant <client> <scope> --level <l> --for <duration>`: temporary grants (SPEC v6 section 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { GRANT_LEVELS, type AccessLevel } from "../core/kinds.js";

const DURATION = /^(\d{1,5})([hdw])$/i;
const DURATION_MS: Readonly<Record<string, number>> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** Parse a duration such as `24h`, `7d` or `2w` into milliseconds from now. */
export function parseDuration(value: string): number {
  const m = DURATION.exec(value.trim());
  if (!m) throw new Error(`Invalid duration "${value}": use an age such as 24h, 7d or 2w.`);
  return Number(m[1]) * (DURATION_MS[(m[2] as string).toLowerCase()] as number);
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      level: { type: "string" },
      for: { type: "string" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const [clientName, scopeName] = positionals;
  const level = values.level as Exclude<AccessLevel, "none"> | undefined;
  if (!clientName || !scopeName || !level || !values.for) {
    console.error("Usage: ctxd grant <client> <scope> --level read|propose|write --for <duration>");
    return 1;
  }
  if (!GRANT_LEVELS.includes(level)) {
    console.error(`ctxd grant: --level must be one of: ${GRANT_LEVELS.join(", ")}.`);
    return 1;
  }
  let durationMs: number;
  try {
    durationMs = parseDuration(values.for);
  } catch (err) {
    console.error(`ctxd grant: ${(err as Error).message}`);
    return 1;
  }

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const client = db.prepare("SELECT client_id FROM clients WHERE name = ?").get(clientName) as { client_id: string } | undefined;
    if (!client) {
      console.error(`ctxd grant: client "${clientName}" not found.`);
      return 1;
    }
    const scope = db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(scopeName) as { scope_id: string } | undefined;
    if (!scope) {
      console.error(`ctxd grant: scope "${scopeName}" not found.`);
      return 1;
    }
    const human = db.prepare("SELECT client_id FROM clients WHERE vendor = 'human' LIMIT 1").get() as { client_id: string };
    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    db.prepare(
      "INSERT INTO client_grants (client_id, scope_id, level, expires_at, granted_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (client_id, scope_id) DO UPDATE SET level = excluded.level, expires_at = excluded.expires_at, granted_by = excluded.granted_by",
    ).run(client.client_id, scope.scope_id, level, expiresAt, human.client_id);
    console.log(`ctxd grant: ${clientName} -> ${scopeName} (${level}) until ${expiresAt}`);
    return 0;
  } finally {
    db.close();
  }
}
