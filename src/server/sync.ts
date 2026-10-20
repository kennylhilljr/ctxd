import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { assertLoopback } from "../security/policy.js";
import { resolvePeerAuth } from "./auth.js";
import { extractBearerToken, parseListen, readJsonBody } from "./http.js";
import { servePull, pullFromPeer, type PullRequest } from "../sync/pull.js";
import type { SealedKeyProvider } from "../sealed/key-provider.js";

/**
 * The sync listener (Spec v8 7.1): a second HTTP server on `sync.listen` (127.0.0.1:7412 by
 * default), separate from the MCP server on 7411, reachable only through `tailscale serve`
 * (never Funnel, ADR 0003). `POST /v1/pull` serves this node's events to an authenticated peer;
 * `POST /v1/notify` triggers an immediate pull *from* the notifying peer, debounced per peer so a
 * burst of local writes on their end triggers at most one extra pull every 5 seconds.
 */
export interface StartSyncServerOptions {
  db: Database.Database;
  nodeId: string;
  listen: string;
  sealedKeys?: SealedKeyProvider;
}

export interface RunningSyncServer {
  close(): Promise<void>;
}

const NOTIFY_DEBOUNCE_MS = 5000;

export async function startSyncServer(opts: StartSyncServerOptions): Promise<RunningSyncServer> {
  assertLoopback(opts.listen);
  const { host, port } = parseListen(opts.listen);
  const notifyTimers = new Map<string, NodeJS.Timeout>();

  const httpServer = createHttpServer((req, res) => {
    handleRequest(req, res, opts.db, opts.nodeId, notifyTimers, opts.sealedKeys).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });

  return {
    close: () =>
      new Promise((resolve) => {
        for (const timer of notifyTimers.values()) clearTimeout(timer);
        httpServer.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  nodeId: string,
  notifyTimers: Map<string, NodeJS.Timeout>,
  sealedKeys?: SealedKeyProvider,
): Promise<void> {
  if (req.method !== "POST" || (req.url !== "/v1/pull" && req.url !== "/v1/notify")) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }

  const token = extractBearerToken(req);
  const auth = token ? resolvePeerAuth(db, token) : null;
  if (!auth) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "missing or invalid peer token" }));
    return;
  }

  if (req.url === "/v1/pull") {
    const body = (await readJsonBody(req)) as Partial<PullRequest> | undefined;
    if (!body || typeof body.node !== "string" || typeof body.vector !== "object" || body.vector === null || typeof body.limit !== "number") {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid pull request" }));
      return;
    }
    const response = servePull(db, auth.peerRole, { node: body.node, vector: body.vector, limit: body.limit }, sealedKeys);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
    return;
  }

  // /v1/notify: debounced immediate pull from the notifying peer (Spec 7.1's "on demand" trigger).
  scheduleNotifyPull(db, nodeId, auth.peerId, auth.peerName, notifyTimers, sealedKeys);
  res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ accepted: true }));
}

function scheduleNotifyPull(db: Database.Database, selfNodeId: string, peerId: string, peerName: string, notifyTimers: Map<string, NodeJS.Timeout>, sealedKeys?: SealedKeyProvider): void {
  if (notifyTimers.has(peerId)) return; // already scheduled; the burst collapses into one pull
  const timer = setTimeout(() => {
    notifyTimers.delete(peerId);
    const peer = db.prepare("SELECT url, outgoing_token FROM peers WHERE peer_id = ? AND revoked_at IS NULL").get(peerId) as
      | { url: string; outgoing_token: string | null }
      | undefined;
    if (!peer?.outgoing_token) return; // no outgoing token yet: can't pull from this peer
    void pullFromPeer(db, selfNodeId, { peerId, name: peerName, url: peer.url, outgoingToken: peer.outgoing_token }, fetch, sealedKeys).catch(() => {
      // A failed notify-triggered pull is not fatal: the scheduled interval loop (src/cli/server.ts) retries it.
    });
  }, NOTIFY_DEBOUNCE_MS);
  notifyTimers.set(peerId, timer);
}
