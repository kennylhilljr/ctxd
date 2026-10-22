/** `ctxd inbox pull|status|set-token|schedule`: M7 mobile inbox (MI-11), plus W7's approved unattended scheduler. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir } from "./common.js";
import { expandHome, loadConfig, type CtxdConfig } from "../config/config.js";
import { isFlagOn, resolveFlags } from "../config/flags.js";
import { openDatabase } from "../store/db.js";
import { readSecret, storeSecret, type KeychainOptions } from "../access/keychain.js";
import { LocalDirInboxTransport } from "../inbox/localDirTransport.js";
import { CloudflareInboxTransport } from "../inbox/cloudflareTransport.js";
import type { BriefPublishTransport, InboxTransport } from "../inbox/types.js";
import { runInboxPull } from "../inbox/pull.js";
import { runPublishBriefs } from "../inbox/publishBriefs.js";
import { run as runScheduleCommand } from "./inbox-schedule.js";

const SERVICE = "ctxd";
const HUB_TOKEN_ACCOUNT = "mobile-inbox/hub-token";

function buildTransport(config: CtxdConfig, opts: KeychainOptions = {}): InboxTransport & Partial<BriefPublishTransport> {
  if (config.inbox.transport === "cloudflare") {
    if (!config.inbox.endpoint) throw new Error("config.toml's [inbox] endpoint is not set");
    const token = readSecret(SERVICE, HUB_TOKEN_ACCOUNT, opts);
    if (!token) throw new Error("no hub token stored; run `ctxd inbox set-token <token>` first");
    return new CloudflareInboxTransport(config.inbox.endpoint, token);
  }
  return new LocalDirInboxTransport(expandHome(config.inbox.dir));
}

function requireClient(db: Database.Database, name: string): string {
  const row = db.prepare("SELECT client_id FROM clients WHERE name = ? AND revoked_at IS NULL").get(name) as { client_id: string } | undefined;
  if (!row) throw new Error(`no "${name}" client found; run \`ctxd client add ${name} --vendor ${name === "human" ? "human" : "other"}\` first`);
  return row.client_id;
}

export async function runPull(db: Database.Database, nodeId: string, config: CtxdConfig, transport: InboxTransport & Partial<BriefPublishTransport>): Promise<number> {
  const flags = resolveFlags(config);
  if (!isFlagOn(flags, "mobile_inbox")) {
    console.log("ctxd inbox pull: mobile_inbox is off; no network calls made.");
    return 0;
  }
  const clientId = requireClient(db, "mobile-inbox");
  const outcome = await runInboxPull(db, nodeId, clientId, transport, flags, { limit: config.inbox.pull_limit });
  console.log(`ctxd inbox pull: ${outcome.fetched} fetched, ${outcome.applied} applied, ${outcome.held} held for review, ${outcome.rejected} rejected, ${outcome.errored} errored`);

  if (isFlagOn(flags, "mobile_inbox.publish_briefs") && config.inbox.publish_scopes.length > 0 && transport.publishBriefs) {
    const humanId = requireClient(db, "human");
    const published = await runPublishBriefs(db, nodeId, humanId, config.inbox.publish_scopes, transport as BriefPublishTransport, flags);
    console.log(`ctxd inbox pull: ${published.published} brief(s) published, ${published.skipped} skipped`);
  }
  return outcome.errored > 0 ? 1 : 0;
}

export async function runStatus(config: CtxdConfig, transport: InboxTransport): Promise<number> {
  const flags = resolveFlags(config);
  if (!isFlagOn(flags, "mobile_inbox")) {
    console.log("ctxd inbox status: mobile_inbox is off.");
    return 0;
  }
  const status = await transport.status();
  console.log(`ctxd inbox status: transport=${config.inbox.transport}, pending=${status.pending}`);
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const configPath = resolveConfigPath({ configPath: values.config });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const config = loadConfig(configPath);

  if (sub === "set-token") {
    const token = positionals[0];
    if (!token) {
      console.error("Usage: ctxd inbox set-token <hub-token>");
      return 1;
    }
    storeSecret(SERVICE, HUB_TOKEN_ACCOUNT, token);
    console.log("ctxd inbox: hub token stored in the Keychain.");
    return 0;
  }

  // Managing the launchd agent needs no database and no transport: it only writes, loads or
  // inspects a plist that runs `ctxd inbox pull` later, on its own. The installed job inherits
  // whichever --config/--data-dir this invocation was given, so a scratch instance schedules
  // itself rather than the default one.
  if (sub === "schedule") {
    return runScheduleCommand(positionals, config.inbox.schedule_minutes, values.config ? configPath : undefined, values["data-dir"] ? dataDir : undefined);
  }

  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
    if (!node) {
      console.error("ctxd inbox: no node identity found; run ctxd init first.");
      return 1;
    }
    if (sub === "pull") return await runPull(db, node.node_id, config, buildTransport(config));
    if (sub === "status") return await runStatus(config, buildTransport(config));
    console.error("Usage: ctxd inbox <pull|status|set-token|schedule>");
    return 1;
  } catch (err) {
    console.error(`ctxd inbox: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
