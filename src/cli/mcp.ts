/**
 * `ctxd mcp --client <id>` (also reachable as `ctxd stdio --client <id>`, M5 slice 2: SPEC v8
 * calls the same command by both names across different sections, e.g. 8.4's "`ctxd mcp` is a
 * stdio MCP server..." versus 9.6's Claude Desktop config using `["stdio", "--client", ...]`;
 * both real deploy files, `deploy/clients/claude-code-mcp.md`/`codex-config.toml` and
 * `deploy/clients/claude-desktop-config.json`, already shipped with one name each, so both stay
 * live rather than picking one and breaking the other). The stdio MCP launcher every client
 * starts from its single, user-level MCP entry (SPEC v8 section 8.4). Resolves the session's
 * persona, reads its token from the Keychain (held only in memory here, never on disk/env/logs),
 * and proxies MCP messages between stdio and the local HTTP server over loopback.
 *
 * M5 resolves SPEC open issue 3 ("decide whether `ctxd stdio` should embed the database directly
 * when the server is not running, or always proxy; current choice: always proxy, and start the
 * server if it is absent"): `ensureServerRunning` probes `/healthz` once at startup and spawns
 * `ctxd server` detached if it is unreachable, the same technique `src/hooks/writeMoments.ts`'s
 * `spawnWorker` uses for its own detached process. This matters most for Claude Desktop, which
 * has no launchd-adjacent setup step of its own and no hook to have started the server earlier.
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir, tokensDir } from "./common.js";
import { loadConfig } from "../config/config.js";
import { openDatabase } from "../store/db.js";
import { readSecret } from "../access/keychain.js";
import { parseListen } from "../server/http.js";

const SERVICE = "ctxd";

interface PersonaResolution {
  poolIds: string[];
  notice?: string;
}

function resolvePersona(db: Database.Database, clientId: string, ctxdPool: string | undefined, scopeName: string | undefined): PersonaResolution {
  if (ctxdPool) {
    const names = ctxdPool
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ids: string[] = [];
    for (const name of names) {
      const row = db.prepare("SELECT pool_id FROM pools WHERE name = ?").get(name) as { pool_id: string } | undefined;
      if (!row) return { poolIds: [], notice: `CTXD_POOL names an unknown pool "${name}"; falling back to _me-only.` };
      ids.push(row.pool_id);
    }
    return { poolIds: [...new Set(ids)].sort() };
  }

  if (scopeName) {
    const scope = db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(scopeName) as { scope_id: string } | undefined;
    if (!scope) return { poolIds: [], notice: `--scope "${scopeName}" is not bound to a ctxd scope; falling back to _me-only.` };
    const pools = db
      .prepare(
        "SELECT pool_id FROM pool_grants WHERE scope_id = ? AND pool_id IN (SELECT pool_id FROM pool_members WHERE principal = ?)",
      )
      .all(scope.scope_id, `client:${clientId}`) as { pool_id: string }[];
    if (pools.length === 1) return { poolIds: [pools[0]!.pool_id] };
    if (pools.length > 1) {
      const pref = db.prepare("SELECT pool_id FROM persona_prefs WHERE client_id = ? AND scope_id = ?").get(clientId, scope.scope_id) as
        | { pool_id: string }
        | undefined;
      if (pref) return { poolIds: [pref.pool_id] };
      return {
        poolIds: [],
        notice: `${pools.length} pools grant "${scopeName}"; falling back to _me-only. Use ctxd persona prefer to resolve.`,
      };
    }
  }

  return { poolIds: [] };
}

function resolveToken(configPath: string, clientName: string, poolIds: readonly string[]): { token: string; notice?: string } {
  if (poolIds.length > 0) {
    const secret = readSecret(SERVICE, `${clientName}/${poolIds.join(",")}`);
    if (secret) return { token: secret };
  }
  const tokenPath = join(tokensDir(configPath), `${clientName}.token`);
  try {
    return {
      token: readFileSync(tokenPath, "utf8").trim(),
      notice: poolIds.length > 0 ? `No persona token issued for [${poolIds.join(", ")}]; using the _me-only token instead.` : undefined,
    };
  } catch {
    throw new Error(`no token found for client "${clientName}" (looked in the Keychain and ${tokenPath})`);
  }
}

type JsonRpcId = string | number | null;

/**
 * What a stdin line asks for: `parse-error` if it is not JSON, otherwise the ids of the requests in
 * it (a notification has no id, so a line of notifications yields none). A batch array yields one
 * id per request in it.
 */
type ParsedLine = { kind: "parse-error" } | { kind: "message"; ids: JsonRpcId[]; batch: boolean };

function requestIdOf(message: unknown): JsonRpcId | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message) || !("id" in message)) return undefined;
  const id = (message as { id: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : undefined;
}

function parseLine(line: string): ParsedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "parse-error" };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const ids = messages.map(requestIdOf).filter((id): id is JsonRpcId => id !== undefined);
  return { kind: "message", ids, batch: Array.isArray(parsed) };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** One error per request in the line, as a single object or, for a batch, an array; null when the line holds only notifications. */
function errorsFor(parsed: Extract<ParsedLine, { kind: "message" }>, code: number, message: string, data?: unknown): string | null {
  if (parsed.ids.length === 0) return null;
  const errors = parsed.ids.map((id) => jsonRpcError(id, code, message, data));
  return JSON.stringify(parsed.batch ? errors : errors[0]);
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: unknown };

/** True for a single JSON-RPC 2.0 response object. */
function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === "2.0" && "id" in v && ("result" in v || "error" in v);
}

/** Extract each event's `data:` payload from a text/event-stream body (one JSON-RPC message each). */
function parseSseMessages(raw: string): string[] {
  return raw
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).trim())
        .join("\n"),
    )
    .filter((msg) => msg.length > 0);
}

function parseJson(text: string): unknown {
  try {
    return text.trim() ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

export interface HttpReply {
  status: number;
  contentType: string;
  body: string;
}

/**
 * The stdout line for one stdin line, given the server's HTTP reply, or null when nothing should be
 * written (#81). Every request in the line gets exactly one JSON-RPC response carrying its id, and a
 * notification gets none. JSON-RPC responses from the server (a JSON body, or every event of an SSE
 * body) are kept; a JSON-RPC error the transport sent with id null is given the pending ids. Anything
 * else (the listener's plain `{ error }` envelope for an auth failure, bad JSON, an oversized body or
 * an internal error, or an empty or non-JSON body) becomes a -32603 error for each pending id, with
 * the HTTP status and the envelope in `data`.
 */
export function responseFor(line: string, reply: HttpReply): string | null {
  const parsed = parseLine(line);
  if (parsed.kind === "parse-error") return JSON.stringify(jsonRpcError(null, -32700, "Parse error"));
  if (parsed.ids.length === 0) return null;

  const bodies = reply.contentType.includes("text/event-stream") ? parseSseMessages(reply.body).map(parseJson) : [parseJson(reply.body)];
  const received = bodies.flatMap((b) => (Array.isArray(b) ? b : [b])).filter(isJsonRpcResponse);

  // The error every request without its own response gets: an id-null transport error if the server sent one, else one built from the reply.
  const uncorrelated = received.find((r) => r.id === null && "error" in r);
  let fallback: (id: JsonRpcId) => Record<string, unknown>;
  if (uncorrelated) fallback = (id) => ({ ...uncorrelated, id });
  else {
    const body = bodies.length === 1 ? bodies[0] : undefined;
    const envelope = (body as { error?: { message?: unknown } } | undefined)?.error;
    if (!isJsonRpcResponse(body) && typeof envelope === "object" && envelope !== null) {
      const message = typeof envelope.message === "string" ? envelope.message : `ctxd server error (HTTP ${reply.status})`;
      fallback = (id) => jsonRpcError(id, -32603, message, { httpStatus: reply.status, ...(body as Record<string, unknown>) });
    } else {
      fallback = (id) => jsonRpcError(id, -32603, `ctxd server returned no JSON-RPC response (HTTP ${reply.status})`, { httpStatus: reply.status });
    }
  }

  const byId = new Map<JsonRpcId, JsonRpcResponse>();
  for (const r of received) if (r.id !== null && !byId.has(r.id)) byId.set(r.id, r);
  const responses = parsed.ids.map((id) => byId.get(id) ?? fallback(id));
  return JSON.stringify(parsed.batch ? responses : responses[0]);
}

/** Forward one line (a JSON-RPC message) to the server over loopback; resolves with the raw HTTP reply. */
function postLine(listen: string, token: string, line: string): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const { host, port } = parseListen(listen);
    const req = httpRequest(
      {
        host,
        port,
        path: "/",
        method: "POST",
        // The Streamable HTTP transport requires both media types to be accepted, even for a
        // plain request/response call with no streaming (SPEC's "direct HTTP responses" mode).
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: res.headers["content-type"] ?? "", body: data }));
      },
    );
    req.on("error", reject);
    req.end(line);
  });
}

/**
 * Proxy one stdin line: the stdout line to write, or null. SPEC v6 NFR-9 ("fail open for reads"):
 * a request that gets no response at all would hang the calling client forever waiting for it, so
 * every request is answered, even when the server is unreachable, letting the agent proceed without
 * ctxd instead of stalling.
 */
export async function proxyLine(listen: string, token: string, line: string): Promise<string | null> {
  const parsed = parseLine(line);
  if (parsed.kind === "parse-error") return responseFor(line, { status: 0, contentType: "", body: "" });
  try {
    return responseFor(line, await postLine(listen, token, line));
  } catch (err) {
    console.error(`ctxd mcp: ${(err as Error).message}. Is "ctxd server" running?`);
    return errorsFor(parsed, -32000, `ctxd server unreachable: ${(err as Error).message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A bare GET /healthz; resolves false on any error rather than rejecting, since "unreachable" is the expected case this exists to detect. */
export function probeServer(listen: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { host, port } = parseListen(listen);
    const req = httpRequest({ host, port, path: "/healthz", method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

const SERVER_START_TIMEOUT_MS = 3000;
const SERVER_START_POLL_MS = 100;

export type ServerSpawner = (dataDir: string, configPath: string) => void;

/** The real spawn: a detached `ctxd server` against the exact binary and node runtime already running this process (same technique `src/hooks/writeMoments.ts`'s `spawnWorker` uses). */
export function spawnServer(dataDir: string, configPath: string): void {
  spawn(process.execPath, [process.argv[1]!, "server", "--data-dir", dataDir, "--config", configPath], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/**
 * SPEC open issue 3's resolved design: always proxy, starting the server first if it is not
 * already up. Spawning a server when one is already running (a benign race between two stdio
 * launchers starting at once) just fails to bind the port and exits; it never disturbs the
 * server that got there first, so this never needs to coordinate with another launcher.
 * `spawnFn` is overridable only for tests; production dispatch always uses the real `spawnServer`.
 */
export async function ensureServerRunning(listen: string, dataDir: string, configPath: string, spawnFn: ServerSpawner = spawnServer): Promise<void> {
  if (await probeServer(listen)) return;
  spawnFn(dataDir, configPath);
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(SERVER_START_POLL_MS);
    if (await probeServer(listen)) return;
  }
  // Not up after the timeout: proceed anyway. proxyLine's own per-line error handling already
  // answers the calling client instead of hanging if the server truly never comes up.
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { client: { type: "string" }, scope: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const clientName = values.client;
  if (!clientName) {
    console.error("Usage: ctxd mcp --client <name> [--scope <scope>]");
    return 1;
  }

  const configPath = resolveConfigPath({ configPath: values.config });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const config = loadConfig(configPath);

  let token: string;
  let listen: string;
  try {
    const db = openDatabase(join(dataDir, "ctxd.db"));
    try {
      const client = db.prepare("SELECT client_id FROM clients WHERE name = ?").get(clientName) as { client_id: string } | undefined;
      if (!client) {
        console.error(`ctxd mcp: client "${clientName}" not found.`);
        return 1;
      }
      const persona = resolvePersona(db, client.client_id, process.env.CTXD_POOL, values.scope);
      if (persona.notice) console.error(`ctxd mcp: ${persona.notice}`);
      const resolved = resolveToken(configPath, clientName, persona.poolIds);
      if (resolved.notice) console.error(`ctxd mcp: ${resolved.notice}`);
      token = resolved.token;
      listen = config.mcp.listen;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`ctxd mcp: ${(err as Error).message}`);
    return 1;
  }

  await ensureServerRunning(listen, dataDir, configPath);

  return new Promise<number>((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        void proxyLine(listen, token, line).then((responseLine) => {
          if (responseLine !== null) process.stdout.write(responseLine.trimEnd() + "\n");
        });
      }
    });
    process.stdin.on("end", () => resolve(0));
  });
}
