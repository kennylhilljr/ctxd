import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { canonicalJson } from "../store/idempotency.js";

export interface SignedEventFields {
  eventId: string;
  originNode: string;
  originSeq: number;
  hlc: string;
  scopeId: string;
  entryId: string;
  op: string;
  part: string;
  parentRevs: readonly string[];
  rev: string;
  clientId: string;
  sessionRef: string | null;
  requestId: string | null;
  requestHash: string | null;
  payload: Record<string, unknown>;
  prev: Record<string, unknown> | null;
}

export interface EventKeyProvider {
  keyPair(nodeId: string): { privateKey: KeyObject; publicKey: KeyObject };
}

const memoryKeys = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>();

export class FileEventKeyProvider implements EventKeyProvider {
  constructor(private readonly databasePath: string) {}

  keyPair(nodeId: string): { privateKey: KeyObject; publicKey: KeyObject } {
    if (this.databasePath === "" || this.databasePath === ":memory:") {
      const existing = memoryKeys.get(nodeId);
      if (existing) return existing;
      const created = generateKeyPairSync("ed25519");
      memoryKeys.set(nodeId, created);
      return created;
    }
    const path = `${this.databasePath}.ed25519.pem`;
    if (existsSync(path)) {
      const privateKey = readFileSync(path);
      const privateObject = createPrivateKey(privateKey);
      return { privateKey: privateObject, publicKey: createPublicKey(privateObject) };
    }
    const created = generateKeyPairSync("ed25519");
    writeFileSync(path, created.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    return created;
  }
}

export function eventPayloadHash(event: SignedEventFields): string {
  return createHash("sha256").update(canonicalJson({ payload: event.payload, prev: event.prev })).digest("hex");
}

function databasePath(db: Database.Database): string {
  const row = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get() as { file: string };
  return row.file;
}

export function signStoredEvent(
  db: Database.Database,
  eventId: string,
  flags?: Map<string, boolean>,
  provider: EventKeyProvider = new FileEventKeyProvider(databasePath(db)),
): void {
  if (flags?.get("signed_events") !== true) return;
  const row = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Cannot sign missing event ${eventId}`);
  const fields = fieldsFromRow(row);
  const hash = eventPayloadHash(fields);
  const keys = provider.keyPair(fields.originNode);
  const signature = sign(null, Buffer.from(hash, "hex"), keys.privateKey).toString("base64");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  db.prepare("UPDATE events SET payload_hash = ?, signature = ?, public_key = ? WHERE event_id = ?").run(hash, signature, publicKey, eventId);
  pinPublicKey(db, fields.originNode, publicKey);
}

export function verifyEventSignature(
  db: Database.Database,
  event: SignedEventFields & { payloadHash?: string | null; signature?: string | null; publicKey?: string | null },
  verifyPayload = true,
): void {
  if (event.signature == null && event.payloadHash == null && event.publicKey == null) return;
  if (!event.signature || !event.payloadHash || !event.publicKey) throw new Error(`Incomplete signature on event ${event.eventId}`);
  if (verifyPayload) {
    const computed = eventPayloadHash(event);
    if (computed !== event.payloadHash) throw new Error(`Payload hash mismatch on event ${event.eventId}`);
  }
  const key = createPublicKey({ key: Buffer.from(event.publicKey, "base64"), type: "spki", format: "der" });
  if (!verify(null, Buffer.from(event.payloadHash, "hex"), key, Buffer.from(event.signature, "base64"))) {
    throw new Error(`Invalid signature on event ${event.eventId}`);
  }
  pinPublicKey(db, event.originNode, event.publicKey);
}

function pinPublicKey(db: Database.Database, nodeId: string, publicKey: string): void {
  const existing = db.prepare("SELECT public_key FROM node_keys WHERE node_id = ?").get(nodeId) as { public_key: string } | undefined;
  if (existing && existing.public_key !== publicKey) throw new Error(`Public key changed for node ${nodeId}`);
  if (!existing) db.prepare("INSERT INTO node_keys (node_id, public_key, first_seen_at) VALUES (?, ?, ?)").run(nodeId, publicKey, new Date().toISOString());
}

export function fieldsFromRow(row: Record<string, unknown>): SignedEventFields {
  return {
    eventId: String(row.event_id), originNode: String(row.origin_node), originSeq: Number(row.origin_seq), hlc: String(row.hlc),
    scopeId: String(row.scope_id), entryId: String(row.entry_id), op: String(row.op), part: String(row.part),
    parentRevs: JSON.parse(String(row.parent_revs)) as string[], rev: String(row.rev), clientId: String(row.client_id),
    sessionRef: row.session_ref === null ? null : String(row.session_ref), requestId: row.request_id === null ? null : String(row.request_id),
    requestHash: row.request_hash === null ? null : String(row.request_hash), payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    prev: row.prev === null ? null : JSON.parse(String(row.prev)) as Record<string, unknown>,
  };
}
