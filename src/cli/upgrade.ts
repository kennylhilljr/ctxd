/**
 * `ctxd upgrade --from <database> [--to <database>]`: rebuild a database whose schema predates the
 * migration chain's first step into a fresh one at the current schema (src/store/upgrade.ts).
 *
 * Deliberately not automatic and deliberately not in place. It writes a new file and leaves the
 * original untouched, so the owner swaps it in themselves once they have read the report, and
 * keeps the old file as its own backup.
 */
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { expandHome } from "../config/config.js";
import { needsUpgrade, upgradeDatabase } from "../store/upgrade.js";
import { SCHEMA_VERSION } from "../store/schema.js";

function usage(): string {
  return "Usage: ctxd upgrade --from <database> [--to <database>]";
}

export function run(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { from: { type: "string" }, to: { type: "string" } }, strict: true });
  if (!values.from) {
    console.error(usage());
    return 1;
  }
  const source = expandHome(values.from);
  if (!existsSync(source)) {
    console.error(`ctxd upgrade: no database at ${source}.`);
    return 1;
  }
  const target = expandHome(values.to ?? join(dirname(source), "ctxd.upgraded.db"));
  if (existsSync(target)) {
    console.error(`ctxd upgrade: ${target} already exists; move it aside or pass --to <path>.`);
    return 1;
  }

  let version: number;
  const probe = new Database(source, { readonly: true });
  try {
    version = probe.pragma("user_version", { simple: true }) as number;
  } finally {
    probe.close();
  }
  if (version === SCHEMA_VERSION) {
    console.log(`ctxd upgrade: ${source} is already at schema ${SCHEMA_VERSION}; nothing to do.`);
    return 0;
  }
  if (!needsUpgrade(version)) {
    console.error(
      `ctxd upgrade: schema ${version} is handled by the ordinary migration chain (or is not a ctxd database); open it normally instead. This command is for versions 1 to 12.`,
    );
    return 1;
  }

  try {
    const report = upgradeDatabase(source, target);
    console.log(`ctxd upgrade: rebuilt schema ${report.fromVersion} into schema ${report.toVersion} at ${target}.`);
    for (const t of report.carried) {
      const dropped = t.droppedColumns.length ? `, dropped column(s) this schema no longer has: ${t.droppedColumns.join(", ")}` : "";
      console.log(`  ${t.table}: ${t.rows} row(s)${dropped}`);
    }
    console.log(`  replayed the event log: ${report.entries} entr(ies), ${report.relations} relation(s)`);
    if (report.aclRowsRestored === null) {
      console.log("  pools and grants came from the event log, which this database has acl events for");
    } else {
      console.log(`  restored ${report.aclRowsRestored} pool, grant and member row(s) that predate acl events, so the replay did not drop them`);
    }
    console.log("");
    console.log("The original is untouched. To use the result:");
    console.log("  1. stop the server:  ctxd service uninstall   (or launchctl unload its plist)");
    console.log(`  2. keep the old file as a backup, then: mv ${target} ${source}`);
    console.log("  3. check it:         ctxd doctor");
    console.log("  4. start it again:   ctxd service install");
    return 0;
  } catch (err) {
    console.error(`ctxd upgrade: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
