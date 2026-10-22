/** `ctxd pool create|show|grant|revoke|add-member|remove-member|seal|enroll|approve-key-transfer|lock` (SPEC v6 section 13). */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { deterministicId } from "../core/ids.js";
import { appendAclEvent } from "../store/acl.js";
import { GRANT_LEVELS, type AccessLevel } from "../core/kinds.js";
import type { WriteContext } from "../store/write.js";
import { loadConfig, type CtxdConfig } from "../config/config.js";
import { isFlagOn, requireFlag, resolveFlags } from "../config/flags.js";
import { KeyHelperProvider } from "../sealed/key-provider.js";
import { SealedPoolStore, SqlCipherDatabaseProvider } from "../sealed/store.js";
import { FileEventKeyProvider } from "../security/event-signatures.js";
import { FileEncryptionKeyProvider, deriveConfirmationCode, signEncryptionPrekey } from "../sealed/encryptionKeys.js";
import { approveKeyTransfer, completeKeyTransfer, type SignedPrekey } from "../sealed/keyTransfer.js";
import type { CiphertextEnvelope } from "../sealed/crypto.js";

function findPool(db: Database.Database, name: string): { pool_id: string } | undefined {
  return db.prepare("SELECT pool_id FROM pools WHERE name = ?").get(name) as { pool_id: string } | undefined;
}

// Excludes the reserved `_system` scope (kind 'system'): it holds acl events only, never
// knowledge content, so it is never a valid pool-grant target (found during /code-review).
function findScope(db: Database.Database, name: string): { scope_id: string } | undefined {
  return db.prepare("SELECT scope_id FROM scopes WHERE name = ? AND kind != 'system'").get(name) as { scope_id: string } | undefined;
}

export function createPool(ctx: WriteContext, name: string, description: string): number {
  if (findPool(ctx.db, name)) {
    console.error(`ctxd pool: "${name}" already exists.`);
    return 1;
  }
  // A pool's id is derived from its name (SPEC v8 4), same reasoning as a scope's.
  const poolId = deterministicId("pool", name);
  appendAclEvent(ctx, poolId, { action: "pool_create", name, description });
  console.log(`ctxd pool created: ${name}`);
  return 0;
}

export function showPool(db: Database.Database, name: string): number {
  const pool = findPool(db, name);
  if (!pool) {
    console.error(`ctxd pool: "${name}" not found.`);
    return 1;
  }
  const grants = db
    .prepare("SELECT s.name AS scope, g.level FROM pool_grants g JOIN scopes s ON s.scope_id = g.scope_id WHERE g.pool_id = ? ORDER BY s.name")
    .all(pool.pool_id) as { scope: string; level: string }[];
  const members = db.prepare("SELECT principal FROM pool_members WHERE pool_id = ? ORDER BY principal").all(pool.pool_id) as {
    principal: string;
  }[];
  console.log(`pool: ${name}`);
  console.log(`  grants: ${grants.length ? grants.map((g) => `${g.scope}:${g.level}`).join(", ") : "(none)"}`);
  console.log(`  members: ${members.length ? members.map((m) => m.principal).join(", ") : "(none)"}`);
  return 0;
}

export function grantPool(ctx: WriteContext, pool: string, scope: string, level: Exclude<AccessLevel, "none">): number {
  const { db } = ctx;
  const poolRow = findPool(db, pool);
  if (!poolRow) {
    console.error(`ctxd pool: "${pool}" not found.`);
    return 1;
  }
  const scopeRow = findScope(db, scope);
  if (!scopeRow) {
    console.error(`ctxd pool: scope "${scope}" not found.`);
    return 1;
  }
  appendAclEvent(ctx, poolRow.pool_id, { action: "pool_grant", scope_id: scopeRow.scope_id, level });
  console.log(`ctxd pool grant: ${pool} -> ${scope} (${level})`);
  return 0;
}

export function revokePoolGrant(ctx: WriteContext, pool: string, scope: string): number {
  const { db } = ctx;
  const poolRow = findPool(db, pool);
  if (!poolRow) {
    console.error(`ctxd pool: "${pool}" not found.`);
    return 1;
  }
  const scopeRow = findScope(db, scope);
  if (!scopeRow) {
    console.error(`ctxd pool: scope "${scope}" not found.`);
    return 1;
  }
  if (!db.prepare("SELECT 1 FROM pool_grants WHERE pool_id = ? AND scope_id = ?").get(poolRow.pool_id, scopeRow.scope_id)) {
    console.error(`ctxd pool: "${pool}" had no grant on "${scope}".`);
    return 1;
  }
  appendAclEvent(ctx, poolRow.pool_id, { action: "pool_revoke", scope_id: scopeRow.scope_id });
  console.log(`ctxd pool revoke: ${pool} -/-> ${scope}`);
  return 0;
}

function principalFor(db: Database.Database, clientOrTag: string, isTag: boolean): string | null {
  if (isTag) return `tag:${clientOrTag}`;
  const client = db.prepare("SELECT client_id FROM clients WHERE name = ?").get(clientOrTag) as { client_id: string } | undefined;
  return client ? `client:${client.client_id}` : null;
}

export function addMember(ctx: WriteContext, pool: string, clientOrTag: string, isTag: boolean): number {
  const { db } = ctx;
  const poolRow = findPool(db, pool);
  if (!poolRow) {
    console.error(`ctxd pool: "${pool}" not found.`);
    return 1;
  }
  const principal = principalFor(db, clientOrTag, isTag);
  if (!principal) {
    console.error(`ctxd pool: client "${clientOrTag}" not found.`);
    return 1;
  }
  appendAclEvent(ctx, poolRow.pool_id, { action: "pool_add_member", principal });
  console.log(`ctxd pool add-member: ${pool} += ${principal}`);
  return 0;
}

export function removeMember(ctx: WriteContext, pool: string, clientOrTag: string, isTag: boolean): number {
  const { db } = ctx;
  const poolRow = findPool(db, pool);
  if (!poolRow) {
    console.error(`ctxd pool: "${pool}" not found.`);
    return 1;
  }
  const principal = principalFor(db, clientOrTag, isTag);
  if (!principal) {
    console.error(`ctxd pool: client "${clientOrTag}" not found.`);
    return 1;
  }
  appendAclEvent(ctx, poolRow.pool_id, { action: "pool_remove_member", principal });
  console.log(`ctxd pool remove-member: ${pool} -= ${principal}`);
  return 0;
}

interface PeerForTransfer {
  url: string;
  outgoing_token: string;
  node_id: string;
}

interface PendingEnrollState {
  poolId: string;
  peerUrl: string;
  outgoingToken: string;
  sourcePrekey: SignedPrekey;
}

function pendingTransferPath(dataDir: string, transferId: string): string {
  return join(dataDir, "key-transfers", `${transferId}.json`);
}

/** W2, start: this node (the recipient) asks the peer for the pool's key. Prints the transferId and a confirmation code derived immediately from the exchange, so the owner can start comparing it against what approving on the source shows. */
async function requestEnroll(db: Database.Database, dataDir: string, poolId: string, poolName: string, peerName: string, peer: PeerForTransfer): Promise<number> {
  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string };
  const dbPath = join(dataDir, "ctxd.db");
  const signingKeys = new FileEventKeyProvider(dbPath).keyPair(node.node_id);
  const encKeys = new FileEncryptionKeyProvider(dbPath).keyPair(node.node_id);
  const myPrekey: SignedPrekey = { nodeId: node.node_id, ...signEncryptionPrekey(node.node_id, encKeys, signingKeys.privateKey) };

  let res: Response;
  try {
    res = await fetch(new URL("/v1/key-transfer/request", peer.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${peer.outgoing_token}` },
      body: JSON.stringify({ poolId, requesterPrekey: myPrekey }),
    });
  } catch (err) {
    console.error(`ctxd pool enroll: could not reach "${peerName}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!res.ok) {
    console.error(`ctxd pool enroll: request refused: HTTP ${res.status} (${await res.text()})`);
    return 1;
  }
  const body = (await res.json()) as { transferId: string; sourcePrekey: SignedPrekey };

  mkdirSync(join(dataDir, "key-transfers"), { recursive: true });
  const state: PendingEnrollState = { poolId, peerUrl: peer.url, outgoingToken: peer.outgoing_token, sourcePrekey: body.sourcePrekey };
  writeFileSync(pendingTransferPath(dataDir, body.transferId), JSON.stringify(state));

  const code = deriveConfirmationCode(encKeys.privateKey, body.sourcePrekey.publicKey);
  console.log(`ctxd pool enroll: requested transfer ${body.transferId} for "${poolName}" from "${peerName}".`);
  console.log(`Confirmation code: ${code}`);
  console.log(`On "${peerName}", run: ctxd pool approve-key-transfer ${body.transferId}  (it will show the same code)`);
  console.log(`Then here, run: ctxd pool enroll ${poolName} ${peerName} --transfer-id ${body.transferId}`);
  return 0;
}

/** W2, finish: fetches the (already-approved) wrapped key, unwraps it, and installs it via SealedPoolStore.enroll, which also records the enrollment. */
async function completeEnroll(db: Database.Database, dataDir: string, config: CtxdConfig, ctx: WriteContext, poolId: string, peer: PeerForTransfer, transferId: string): Promise<number> {
  const statePath = pendingTransferPath(dataDir, transferId);
  if (!existsSync(statePath)) {
    console.error(`ctxd pool enroll: no pending request for transfer ${transferId} on this node.`);
    return 1;
  }
  const state = JSON.parse(readFileSync(statePath, "utf8")) as PendingEnrollState;

  let res: Response;
  try {
    res = await fetch(new URL("/v1/key-transfer/fetch", peer.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${peer.outgoing_token}` },
      body: JSON.stringify({ transferId }),
    });
  } catch (err) {
    console.error(`ctxd pool enroll: could not reach the source node: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!res.ok) {
    console.error(`ctxd pool enroll: fetch refused: HTTP ${res.status} (${await res.text()})`);
    return 1;
  }
  const { wrappedKey } = (await res.json()) as { wrappedKey: CiphertextEnvelope };

  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string };
  const encKeys = new FileEncryptionKeyProvider(join(dataDir, "ctxd.db")).keyPair(node.node_id);
  const completion = completeKeyTransfer(transferId, encKeys, state.sourcePrekey, wrappedKey);
  console.log(`Confirmation code: ${completion.confirmationCode}  (compare against what approving showed on the source)`);

  const store = new SealedPoolStore(db, dataDir, new KeyHelperProvider(config.sealed.key_helper), new SqlCipherDatabaseProvider(), config.sealed.unlock_minutes);
  store.enroll(state.poolId, node.node_id, completion.poolKey);
  appendAclEvent(ctx, state.poolId, { action: "pool_enroll", node_id: node.node_id });
  unlinkSync(statePath);
  console.log(`ctxd pool enroll: enrolled on this node.`);
  return 0;
}

/** W2, owner-only: approves a pending transfer on the source node, wrapping the real pool key for the requester. Never reachable except by this CLI command running locally. */
function approveKeyTransferCommand(db: Database.Database, dataDir: string, config: CtxdConfig, transferId: string): number {
  const transfer = db.prepare("SELECT pool_id FROM sealed_key_transfers WHERE transfer_id = ?").get(transferId) as { pool_id: string } | undefined;
  if (!transfer) {
    console.error(`ctxd pool approve-key-transfer: no such transfer ${transferId}.`);
    return 1;
  }
  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string };
  const keys = isFlagOn(resolveFlags(config), "sealed_pools") ? new KeyHelperProvider(config.sealed.key_helper) : undefined;
  if (!keys) {
    console.error("ctxd pool approve-key-transfer: sealed_pools is off.");
    return 1;
  }
  const encKeys = new FileEncryptionKeyProvider(join(dataDir, "ctxd.db")).keyPair(node.node_id);
  try {
    const poolKey = keys.get(transfer.pool_id);
    const { confirmationCode } = approveKeyTransfer(db, transferId, encKeys, poolKey);
    console.log(`ctxd pool approve-key-transfer: approved ${transferId}.`);
    console.log(`Confirmation code: ${confirmationCode}  (compare against what the requester shows)`);
    return 0;
  } catch (err) {
    console.error(`ctxd pool approve-key-transfer: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `ctxd pool rekey <pool> [--yes]` (W7's approved follow-up to W2). Without `--yes` this only
 * previews: re-encrypting a pool's database is the one sealed-pool operation that cannot be
 * undone, and it costs every other enrolled node its access, so the default is to show what
 * would happen and change nothing (the same shape as `ctxd scope rollback`'s own preview).
 */
function rekeyPool(
  db: Database.Database,
  dataDir: string,
  config: CtxdConfig,
  ctx: WriteContext,
  poolId: string,
  poolName: string,
  confirmed: boolean,
): number {
  const sealed = db.prepare("SELECT 1 FROM pools WHERE pool_id = ? AND storage = 'sealed'").get(poolId);
  if (!sealed) {
    // Checked here too, not only inside the store: otherwise a preview would print a confident
    // plan for a pool that has no key and no file to re-encrypt.
    console.error(`ctxd pool rekey: "${poolName}" is not a sealed pool; there is no key to rotate.`);
    return 1;
  }
  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string };
  const others = (db.prepare("SELECT node_id FROM pool_enrollments WHERE pool_id = ? AND node_id <> ? ORDER BY node_id").all(poolId, node.node_id) as { node_id: string }[]).map(
    (row) => row.node_id,
  );

  if (!confirmed) {
    console.log(`ctxd pool rekey: would rotate the key for "${poolName}" and re-encrypt its database file.`);
    console.log(`  nodes that would lose access until they re-enroll: ${others.length ? others.join(", ") : "none"}`);
    console.log("  backups taken before the rotation stay readable only with the OLD key, which this does not keep.");
    console.log("Nothing was changed. Re-run with --yes to rotate.");
    return 0;
  }

  const store = new SealedPoolStore(db, dataDir, new KeyHelperProvider(config.sealed.key_helper), new SqlCipherDatabaseProvider(), config.sealed.unlock_minutes);
  try {
    const dropped = store.rekey(poolId, node.node_id);
    for (const nodeId of dropped) appendAclEvent(ctx, poolId, { action: "pool_unenroll", node_id: nodeId });
    console.log(`ctxd pool rekey: rotated the key for "${poolName}" and re-encrypted its database.`);
    if (dropped.length) {
      console.log(`  un-enrolled (they hold the old key): ${dropped.join(", ")}`);
      console.log(`  re-enroll each with: ctxd pool enroll ${poolName} <node>`);
    }
    console.log("  backups taken before now need the OLD key; this rotation did not keep it.");
    return 0;
  } catch (err) {
    console.error(`ctxd pool rekey: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    store.close();
  }
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      description: { type: "string" },
      level: { type: "string" },
      tag: { type: "boolean" },
      "transfer-id": { type: "string" },
      yes: { type: "boolean" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const config = loadConfig(resolveConfigPath({ configPath: values.config }));
  const flags = resolveFlags(config);
  const db = openDatabase(join(dataDir, "ctxd.db"));
  const humanContext = (): WriteContext => {
    const ctx = resolveHumanWriteContext(db);
    ctx.flags = flags;
    return ctx;
  };
  try {
    switch (sub) {
      case "create": {
        const name = positionals[0];
        if (!name) {
          console.error("Usage: ctxd pool create <name> [--description <text>]");
          return 1;
        }
        return createPool(humanContext(), name, values.description ?? "");
      }
      case "show": {
        const name = positionals[0];
        if (!name) {
          console.error("Usage: ctxd pool show <name>");
          return 1;
        }
        return showPool(db, name);
      }
      case "grant": {
        const [pool, scope] = positionals;
        const level = values.level as Exclude<AccessLevel, "none"> | undefined;
        if (!pool || !scope || !level) {
          console.error("Usage: ctxd pool grant <pool> <scope> --level read|propose|write");
          return 1;
        }
        if (!GRANT_LEVELS.includes(level)) {
          console.error(`ctxd pool: --level must be one of: ${GRANT_LEVELS.join(", ")}.`);
          return 1;
        }
        return grantPool(humanContext(), pool, scope, level);
      }
      case "revoke": {
        const [pool, scope] = positionals;
        if (!pool || !scope) {
          console.error("Usage: ctxd pool revoke <pool> <scope>");
          return 1;
        }
        return revokePoolGrant(humanContext(), pool, scope);
      }
      case "add-member": {
        const [pool, clientOrTag] = positionals;
        if (!pool || !clientOrTag) {
          console.error("Usage: ctxd pool add-member <pool> <client> | --tag <tag>");
          return 1;
        }
        return addMember(humanContext(), pool, clientOrTag, values.tag === true);
      }
      case "remove-member": {
        const [pool, clientOrTag] = positionals;
        if (!pool || !clientOrTag) {
          console.error("Usage: ctxd pool remove-member <pool> <client> | --tag <tag>");
          return 1;
        }
        return removeMember(humanContext(), pool, clientOrTag, values.tag === true);
      }
      case "seal": {
        requireFlag(flags, "sealed_pools");
        const name = positionals[0];
        const pool = name ? findPool(db, name) : undefined;
        if (!name || !pool) { console.error("Usage: ctxd pool seal <pool>"); return 1; }
        const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string };
        const store = new SealedPoolStore(db, dataDir, new KeyHelperProvider(config.sealed.key_helper), new SqlCipherDatabaseProvider(), config.sealed.unlock_minutes);
        const file = store.seal(pool.pool_id, node.node_id);
        appendAclEvent(humanContext(), pool.pool_id, { action: "pool_seal", sealed_file: file });
        appendAclEvent(humanContext(), pool.pool_id, { action: "pool_enroll", node_id: node.node_id });
        console.log(`ctxd pool sealed: ${name} (${file})`);
        return 0;
      }
      case "enroll": {
        requireFlag(flags, "sealed_pools");
        requireFlag(flags, "sealed_pools.key_transfer");
        const [name, nodeName] = positionals;
        const pool = name ? findPool(db, name) : undefined;
        const peer = nodeName
          ? (db
              .prepare(
                "SELECT url, outgoing_token, remote_node_id AS node_id FROM peers WHERE (name = ? OR remote_node_id = ?) AND revoked_at IS NULL AND remote_node_id IS NOT NULL AND remote_public_key IS NOT NULL",
              )
              .get(nodeName, nodeName) as { url: string; outgoing_token: string | null; node_id: string } | undefined)
          : undefined;
        if (!name || !nodeName || !pool || !peer) {
          console.error("Usage: ctxd pool enroll <pool> <node>  (run again with --transfer-id once approved on <node>)");
          return 1;
        }
        const outgoingToken = peer.outgoing_token;
        if (!outgoingToken) {
          console.error(`ctxd pool enroll: no outgoing token for peer "${nodeName}" yet; run "ctxd node add-peer" first.`);
          return 1;
        }
        const peerForTransfer: PeerForTransfer = { url: peer.url, outgoing_token: outgoingToken, node_id: peer.node_id };
        return values["transfer-id"]
          ? await completeEnroll(db, dataDir, config, humanContext(), pool.pool_id, peerForTransfer, values["transfer-id"])
          : await requestEnroll(db, dataDir, pool.pool_id, name, nodeName, peerForTransfer);
      }
      case "approve-key-transfer": {
        requireFlag(flags, "sealed_pools.key_transfer");
        const transferId = positionals[0];
        if (!transferId) { console.error("Usage: ctxd pool approve-key-transfer <transferId>"); return 1; }
        return approveKeyTransferCommand(db, dataDir, config, transferId);
      }
      case "rekey": {
        requireFlag(flags, "sealed_pools");
        requireFlag(flags, "sealed_pools.rekey");
        const name = positionals[0];
        const pool = name ? findPool(db, name) : undefined;
        if (!name || !pool) { console.error("Usage: ctxd pool rekey <pool> [--yes]"); return 1; }
        return rekeyPool(db, dataDir, config, humanContext(), pool.pool_id, name, values.yes === true);
      }
      case "lock": {
        requireFlag(flags, "sealed_pools");
        const name = positionals[0];
        const pool = name ? findPool(db, name) : undefined;
        if (!name || !pool) { console.error("Usage: ctxd pool lock <pool>"); return 1; }
        const store = new SealedPoolStore(db, dataDir, new KeyHelperProvider(config.sealed.key_helper), new SqlCipherDatabaseProvider(), config.sealed.unlock_minutes);
        store.lock(pool.pool_id);
        console.log(`ctxd pool locked: ${name}`);
        return 0;
      }
      default:
        console.error(`ctxd pool: unknown subcommand "${sub}". Use create, show, grant, revoke, add-member, remove-member, seal, enroll, approve-key-transfer, rekey or lock.`);
        return 2;
    }
  } finally {
    db.close();
  }
}
