import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyLine, responseFor } from "../../src/cli/mcp.js";
import { sha256Hex } from "../../src/core/hash.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { startServer } from "../../src/server/mcp.js";

/**
 * #81: the `ctxd mcp` launcher answers every request on stdout with a JSON-RPC response carrying
 * that request's id (SPEC 8.4 step 6, NFR-9). The MCP listener answers transport-level failures
 * (auth, bad JSON, an oversized body, an internal error) with a plain `{ error }` envelope, which
 * the launcher used to forward unchanged; it now wraps it as a JSON-RPC error.
 */

const REAL_MCP_PORT = 18432;
const closers: (() => Promise<void>)[] = [];
const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A loopback stand-in for `ctxd server` whose every POST gets the reply `handler` writes. */
async function fakeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ listen: string; posts: () => number }> {
  let posts = 0;
  const server: Server = createHttpServer((req, res) => {
    posts++;
    req.resume();
    req.on("end", () => handler(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { listen: `127.0.0.1:${(server.address() as AddressInfo).port}`, posts: () => posts };
}

function replyWith(status: number, body: string, contentType = "application/json") {
  return (_req: IncomingMessage, res: ServerResponse) => res.writeHead(status, { "content-type": contentType }).end(body);
}

const call = (id: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });

const envelope401 = JSON.stringify({
  error: { code: "UNAUTHORIZED", message: "Missing or invalid token", hint: "Your ctxd token is missing or revoked; tell the user.", retryable: false, details: {} },
});

describe("ctxd mcp launcher: transport errors become JSON-RPC errors (#81)", () => {
  it.each([
    ["a numeric id", 7],
    ["id 0", 0],
    ["a string id", "req-1"],
    ["an empty string id", ""],
  ])("wraps a 401 envelope as a JSON-RPC error for %s, keeping the ctxd error details", async (_label, id) => {
    const { listen } = await fakeServer(replyWith(401, envelope401));
    const out = JSON.parse((await proxyLine(listen, "t", call(id)))!);
    expect(out).toEqual({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "Missing or invalid token", data: { httpStatus: 401, ...JSON.parse(envelope401) } },
    });
  });

  it.each([
    [400, { error: { code: "VALIDATION", message: "Invalid JSON body" } }],
    [413, { error: { code: "VALIDATION", message: "Request body too large" } }],
    [500, { error: { code: "VALIDATION", message: "Internal error (request abc)", requestId: "abc" } }],
  ])("wraps an HTTP %i envelope with the request id", async (status, body) => {
    const { listen } = await fakeServer(replyWith(status, JSON.stringify(body)));
    const out = JSON.parse((await proxyLine(listen, "t", call(3)))!);
    expect(out).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: body.error.message, data: { httpStatus: status, ...body } } });
  });

  it.each([
    ["an empty body", ""],
    ["a non-JSON body", "<html>Bad Gateway</html>"],
  ])("answers %s with a generic correlated error", async (_label, body) => {
    const { listen } = await fakeServer(replyWith(502, body, "text/html"));
    const out = JSON.parse((await proxyLine(listen, "t", call("x")))!);
    expect(out).toEqual({ jsonrpc: "2.0", id: "x", error: { code: -32603, message: "ctxd server returned no JSON-RPC response (HTTP 502)", data: { httpStatus: 502 } } });
  });

  it("passes a JSON-RPC result through unchanged, including a tool result with isError", async () => {
    const result = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "{}" }], isError: true } });
    const { listen } = await fakeServer(replyWith(200, result));
    expect(await proxyLine(listen, "t", call(4))).toBe(result);
  });

  it("passes a JSON-RPC error with a numeric code through unchanged", async () => {
    const error = JSON.stringify({ jsonrpc: "2.0", id: 5, error: { code: -32601, message: "Method not found" } });
    const { listen } = await fakeServer(replyWith(200, error));
    expect(await proxyLine(listen, "t", call(5))).toBe(error);
  });

  it("extracts the JSON-RPC message from an SSE reply", async () => {
    const result = JSON.stringify({ jsonrpc: "2.0", id: 6, result: { tools: [] } });
    const { listen } = await fakeServer(replyWith(200, `event: message\ndata: ${result}\n\n`, "text/event-stream"));
    expect(await proxyLine(listen, "t", call(6))).toBe(result);
  });

  it("gives an id-null JSON-RPC error from the transport the pending request's id", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Not Acceptable" } });
    const out = JSON.parse(responseFor(call(9), { status: 406, contentType: "application/json", body })!);
    expect(out).toEqual({ jsonrpc: "2.0", id: 9, error: { code: -32000, message: "Not Acceptable" } });
  });

  it("gives an id-null transport error to every request in a batch", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Not Acceptable" } });
    const out = JSON.parse(responseFor(`[${call(1)},${call(2)}]`, { status: 406, contentType: "application/json", body })!) as { id: unknown; error: { code: number } }[];
    expect(out).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Not Acceptable" } },
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Not Acceptable" } },
    ]);
  });

  it("keeps every event of an SSE reply to a batch, and fills in a request the server did not answer", () => {
    const one = { jsonrpc: "2.0", id: 1, result: { a: 1 } };
    const two = { jsonrpc: "2.0", id: 2, result: { b: 2 } };
    const sse = `event: message\ndata: ${JSON.stringify(one)}\n\nevent: message\ndata: ${JSON.stringify(two)}\n\n`;
    const out = JSON.parse(responseFor(`[${call(1)},${call(2)},${call(3)}]`, { status: 200, contentType: "text/event-stream", body: sse })!) as { id: unknown }[];
    expect(out.slice(0, 2)).toEqual([one, two]);
    expect(out[2]).toMatchObject({ id: 3, error: { code: -32603 } });
  });

  it("writes nothing for a response the client sends back to the server (HTTP 202, empty body)", () => {
    const clientResponse = JSON.stringify({ jsonrpc: "2.0", id: 8, result: {} });
    expect(responseFor(clientResponse, { status: 202, contentType: "", body: "" })).toBeNull();
  });

  it("passes through the server's result for a request with an explicit null id", () => {
    const result = { jsonrpc: "2.0", id: null, result: { tools: [] } };
    expect(JSON.parse(responseFor(call(null), { status: 200, contentType: "application/json", body: JSON.stringify(result) })!)).toEqual(result);
  });

  it.each([
    ["an object with neither method nor result", "{}"],
    ["an empty batch", "[]"],
  ])("answers %s as one invalid request with id null", (_label, line) => {
    const out = JSON.parse(responseFor(line, { status: 400, contentType: "application/json", body: "" })!);
    expect(out).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32603 } });
  });

  it("writes nothing for a notification, even when the server fails", async () => {
    const { listen } = await fakeServer(replyWith(500, JSON.stringify({ error: { code: "VALIDATION", message: "Internal error" } })));
    expect(await proxyLine(listen, "t", notification)).toBeNull();
  });

  it("answers a line that is not JSON with -32700 and id null, without contacting the server", async () => {
    const server = await fakeServer(replyWith(200, "{}"));
    const out = JSON.parse((await proxyLine(server.listen, "t", "{not json"))!);
    expect(out).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(server.posts()).toBe(0);
  });

  it("answers each request in a batch, skipping its notifications", async () => {
    const { listen } = await fakeServer(replyWith(401, envelope401));
    const batch = `[${call(1)},${notification},${call("two")}]`;
    const out = JSON.parse((await proxyLine(listen, "t", batch))!) as { id: unknown; error: { code: number } }[];
    expect(out.map((r) => [r.id, r.error.code])).toEqual([
      [1, -32603],
      ["two", -32603],
    ]);
  });

  it("keeps the correlated -32000 answer when the server is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { listen } = await fakeServer(replyWith(200, "{}"));
    await closers.pop()!(); // nothing listens on the port any more
    const out = JSON.parse((await proxyLine(listen, "t", call(11)))!) as { id: unknown; error: { code: number; message: string } };
    expect(out.id).toBe(11);
    expect(out.error.code).toBe(-32000);
    expect(out.error.message).toMatch(/^ctxd server unreachable/);
  });

  it("correlates concurrent requests that fail differently", async () => {
    const { listen } = await fakeServer((req, res) => {
      if (req.headers.authorization === "Bearer good") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: "a", result: {} }));
      else replyWith(401, envelope401)(req, res);
    });
    const [a, b] = await Promise.all([proxyLine(listen, "good", call("a")), proxyLine(listen, "bad", call("b"))]);
    expect(JSON.parse(a!)).toEqual({ jsonrpc: "2.0", id: "a", result: {} });
    expect(JSON.parse(b!)).toMatchObject({ id: "b", error: { code: -32603 } });
  });

  it("wraps a real ctxd server's auth failure as a JSON-RPC error with the request id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxd-launcher-errors-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "ctxd.db"), { create: true });
    dbs.push(db);
    const nodeId = newId();
    db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'node-a', 'home', ?)").run(nodeId, new Date().toISOString());
    db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'codex', 'openai', ?, ?, ?)").run(
      newId(),
      nodeId,
      sha256Hex(newId()),
      new Date().toISOString(),
    );
    const server = await startServer({ db, nodeId, listen: `127.0.0.1:${REAL_MCP_PORT}` });
    closers.push(() => server.close());

    const out = JSON.parse((await proxyLine(`127.0.0.1:${REAL_MCP_PORT}`, "not-a-real-token", call(42)))!);
    expect(out).toMatchObject({ jsonrpc: "2.0", id: 42, error: { code: -32603, message: "Missing or invalid token", data: { httpStatus: 401, error: { code: "UNAUTHORIZED" } } } });
  });
});
