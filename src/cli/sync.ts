/** `ctxd sync [--peer <name>]`: pull now (Spec v8 7.1, 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { pullFromPeer } from "../sync/pull.js";

interface PeerRow {
  peer_id: string;
  name: string;
  url: string;
  outgoing_token: string | null;
}

function peersToSync(db: Database.Database, only: string | undefined): PeerRow[] {
  const rows = db.prepare("SELECT peer_id, name, url, outgoing_token FROM peers WHERE revoked_at IS NULL ORDER BY name").all() as PeerRow[];
  if (!only) return rows;
  return rows.filter((r) => r.name === only);
}

export async function runSync(db: Database.Database, selfNodeId: string, only: string | undefined): Promise<number> {
  const peers = peersToSync(db, only);
  if (only && peers.length === 0) {
    console.error(`ctxd sync: peer "${only}" not found (or revoked).`);
    return 1;
  }
  if (peers.length === 0) {
    console.log("ctxd sync: no peers configured.");
    return 0;
  }

  let failed = 0;
  for (const peer of peers) {
    if (!peer.outgoing_token) {
      console.error(`ctxd sync: ${peer.name}: no outgoing token yet (run ctxd node add-peer ${peer.name} ... --token <...>).`);
      failed++;
      continue;
    }
    try {
      const outcome = await pullFromPeer(db, selfNodeId, { peerId: peer.peer_id, name: peer.name, url: peer.url, outgoingToken: peer.outgoing_token });
      console.log(`ctxd sync: ${peer.name}: ${outcome.pulled} applied, ${outcome.deferred} deferred`);
    } catch (err) {
      console.error(`ctxd sync: ${peer.name}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  return failed > 0 ? 1 : 0;
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { peer: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
    if (!node) {
      console.error("ctxd sync: no node identity found; run ctxd init first.");
      return 1;
    }
    return await runSync(db, node.node_id, values.peer);
  } finally {
    db.close();
  }
}
