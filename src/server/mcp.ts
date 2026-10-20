import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assertLoopback } from "../security/policy.js";
import { expandHome, loadConfig } from "../config/config.js";
import { isFlagOn, resolveFlags } from "../config/flags.js";
import { extractBearerToken, parseListen, readJsonBody } from "./http.js";
import { toolDefinitions } from "../tools/list.js";
import { TOOLS } from "../tools/schemas.js";
import { coerceInput } from "../tools/coerce.js";
import { TOOL_HANDLERS } from "../tools/handlers.js";
import { SERVER_INSTRUCTIONS } from "../tools/instructions.js";
import { CtxdError, type ErrorEnvelope } from "../core/errors.js";
import { estimateTokens } from "../core/tokens.js";
import { HlcClock } from "../core/hlc.js";
import { nowIso } from "../core/time.js";
import { resolveBearerAuth } from "./auth.js";
import type { RequestContext } from "./context.js";

/**
 * MCP Streamable HTTP server on 127.0.0.1 (SPEC v6 sections 1 and 8): authenticates every
 * request, coerces and validates its input, dispatches to tools/handlers.ts, and wraps the
 * result (or a CtxdError) in the SPEC v6 8.5 error envelope. One tool_metrics row per response.
 */

export interface StartServerOptions {
  db: Database.Database;
  nodeId: string;
  /** "host:port"; refused unless loopback (ADR 0003). */
  listen: string;
  /** Reloaded fresh per request for live flag reload (PRD-feature-flags-v1 section 2); omitted means every flag uses its registry default. */
  configPath?: string;
}

export interface RunningServer {
  close(): Promise<void>;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  assertLoopback(opts.listen);
  const { host, port } = parseListen(opts.listen);
  const clock = new HlcClock(opts.nodeId);

  const httpServer = createHttpServer((req, res) => {
    handleHttpRequest(req, res, opts.db, opts.nodeId, clock, opts.configPath).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "VALIDATION", message: (err as Error).message } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });

  return { close: () => new Promise((resolve) => httpServer.close(() => resolve())) };
}

/**
 * Live reload without a restart (PRD-feature-flags-v1 section 2), at the cost of one `stat` per
 * request rather than a full config parse and schema validation: re-reads and re-validates
 * config.toml only when its mtime has actually changed since the last request, so a flag flip
 * still takes effect on the very next call.
 */
let flagsCache: { configPath: string; mtimeMs: number; flags: Map<string, boolean> } | undefined;

function currentFlags(configPath: string | undefined): Map<string, boolean> {
  if (!configPath) return resolveFlags(undefined);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(configPath).mtimeMs;
  } catch {
    return resolveFlags(undefined); // no config file yet: every flag at its registry default
  }
  if (flagsCache?.configPath === configPath && flagsCache.mtimeMs === mtimeMs) return flagsCache.flags;

  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    config = undefined;
  }
  const flags = resolveFlags(config);
  flagsCache = { configPath, mtimeMs, flags };
  return flags;
}

/** The node's data directory, for loading the local embedding model at query time (SPEC v8 11.2). */
function currentDataDir(configPath: string | undefined): string | undefined {
  try {
    return expandHome(loadConfig(configPath).node.data_dir);
  } catch {
    return undefined;
  }
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  nodeId: string,
  clock: HlcClock,
  configPath?: string,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "VALIDATION", message: "POST only" } }));
    return;
  }

  const token = extractBearerToken(req);
  const auth = token ? resolveBearerAuth(db, token) : null;
  if (!auth) {
    const envelope: ErrorEnvelope = {
      error: { code: "UNAUTHORIZED", message: "Missing or invalid token", hint: "Your ctxd token is missing or revoked; tell the user.", retryable: false, details: {} },
    };
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify(envelope));
    return;
  }
  const ctx: RequestContext = {
    db,
    clock,
    nodeId,
    clientId: auth.clientId,
    clientName: auth.clientName,
    vendor: auth.vendor,
    assumedPools: auth.assumedPools,
    flags: currentFlags(configPath),
    dataDir: currentDataDir(configPath),
  };

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "VALIDATION", message: "Invalid JSON body" } }));
    return;
  }

  const server = new Server({ name: "ctxd", version: "0.0.1" }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(ctx, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handleToolCall(ctx: RequestContext, toolName: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const contract = TOOLS_BY_NAME.get(toolName);
  if (!contract) return errorResult(new CtxdError("VALIDATION", `Unknown tool: ${toolName}`), ctx, toolName, null);

  const { input: coerced, coerced: coercions } = coerceInput(toolName, rawArgs);

  let validated: Record<string, unknown>;
  try {
    validated = contract.input.parse(coerced) as Record<string, unknown>;
  } catch (err) {
    const issue = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues?.[0];
    const field = issue?.path?.length ? issue.path.join(".") : undefined;
    return errorResult(new CtxdError("VALIDATION", issue?.message ?? "Invalid input", {}, field), ctx, toolName, null, coercions);
  }

  const scopeId = typeof validated.scope === "string" ? scopeIdFor(ctx.db, validated.scope) : null;

  const handler = TOOL_HANDLERS[toolName];
  if (!handler) throw new Error(`no handler registered for tool "${toolName}"`); // a real bug, not a user-facing error

  let result: unknown;
  try {
    result = await handler(ctx, validated);
  } catch (err) {
    if (err instanceof CtxdError) return errorResult(err, ctx, toolName, scopeId, coercions);
    throw err;
  }

  const body: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  if (coercions.length) body.coerced = coercions;
  const text = JSON.stringify(body);
  const truncated = Boolean((result as { truncated?: boolean } | undefined)?.truncated);
  recordMetrics(ctx, toolName, scopeId, text, truncated);
  return { content: [{ type: "text", text }] };
}

function errorResult(
  err: CtxdError,
  ctx: RequestContext,
  toolName: string,
  scopeId: string | null,
  coercions: { field: string; from: string; to: string }[] = [],
): ToolResult {
  const envelope: Record<string, unknown> = { ...err.toJSON() };
  if (coercions.length) envelope.coerced = coercions;
  const text = JSON.stringify(envelope);
  recordMetrics(ctx, toolName, scopeId, text, false);
  return { content: [{ type: "text", text }], isError: true };
}

function scopeIdFor(db: Database.Database, scopeName: string): string | null {
  const row = db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(scopeName) as { scope_id: string } | undefined;
  return row?.scope_id ?? null;
}

function recordMetrics(ctx: RequestContext, tool: string, scopeId: string | null, text: string, truncated: boolean): void {
  if (!isFlagOn(ctx.flags, "metering")) return; // metering off (PRD-feature-flags-v1 section 4): response sizes are not recorded
  ctx.db
    .prepare("INSERT INTO tool_metrics (at, client_id, tool, scope_id, chars, est_tokens, truncated) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(nowIso(), ctx.clientId, tool, scopeId, text.length, estimateTokens(text), truncated ? 1 : 0);
}
