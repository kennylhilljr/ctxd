/**
 * `ctxd worker <ticket-path>` (SPEC v8 9.7): takes the ticket's own lock, performs the deferred
 * hook work it describes, and removes the ticket. Spawned detached by a hook whose work does not
 * reliably fit the adapter's time budget (today, only SessionEnd); never run directly by a
 * client's hook configuration, and never surfaces an error anywhere a person would see it, since
 * by the time it runs the session that queued the work is already gone.
 *
 * A ticket still present after this exits (a missed lock, a crash mid-run, a reboot before the
 * worker ran at all) is picked up by the next crash sweep (src/hooks/crashSweep.ts), per SPEC
 * 9.7's own "tickets left behind are picked up by the next crash sweep."
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveConfigPath, resolveDataDir } from "./common.js";
import { loadConfig } from "../config/config.js";
import { resolveFlags } from "../config/flags.js";
import { openDatabase } from "../store/db.js";
import { readStateFile, withLock } from "../hooks/stateFile.js";
import { applySessionEndTicket, type SessionEndTicket } from "../hooks/writeMoments.js";

function resolveFlagsOrUndefined(configPath: string): Map<string, boolean> | undefined {
  try {
    return resolveFlags(loadConfig(configPath));
  } catch {
    return undefined; // no config, or unreadable: performSessionEnd's isFlagOn default (every flag on) applies
  }
}

/**
 * Reads and processes one ticket file under its own lock, deleting it only once the work (or the
 * decision that there is none to do) has actually completed. Leaves the ticket in place, for the
 * next attempt, if the lock could not be taken (another worker or the crash sweep already holds
 * it) -- never deletes a ticket it did not itself finish.
 */
export async function processTicketFile(ticketPath: string, dataDir: string, configPath: string): Promise<void> {
  await withLock(ticketPath, async () => {
    const ticket = readStateFile<SessionEndTicket>(ticketPath);
    if (!ticket) return; // gone, or not valid JSON: nothing to do
    const db = openDatabase(join(dataDir, "ctxd.db"));
    try {
      const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
      if (node) applySessionEndTicket(db, node.node_id, ticket, resolveFlagsOrUndefined(configPath));
    } finally {
      db.close();
    }
    if (existsSync(ticketPath)) unlinkSync(ticketPath);
  });
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const ticketPath = positionals[0];
  if (!ticketPath) return 0; // never breaks; nothing named means nothing to do
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const configPath = resolveConfigPath({ configPath: values.config });
  try {
    await processTicketFile(ticketPath, dataDir, configPath);
  } catch {
    // Nothing left to report to: the ticket, if still present, waits for the next crash sweep.
  }
  return 0;
}
