import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/core/hash.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { startSyncServer } from "../../src/server/sync.js";
import { startServer } from "../../src/server/mcp.js";
import { applyServerTimeouts, HttpBodyError, logInternalError, MAX_BODY_BYTES, readJsonBody } from "../../src/server/http.js";

/**
 * #72: both loopback listeners cap the request body (413), answer bad JSON with 400, and never put
 * an internal error's message (SQLite, filesystem) into a response; a 500 carries only a request id.
 */

const SYNC_PORT = 18430;
const MCP_PORT = 18431;
const closers: (() => Promise<void>)[] = [];
const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function now(): string {
  return new Date().toISOString();
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ctxd-http-limits-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "ctxd.db"), { create: true });
  dbs.push(db);
  return db;
}

/**
 * Declares a body one byte over the cap and sends none of it: the listener must answer 413 from the
 * header alone. (Streaming a real oversized upload races the server's socket close against the
 * client's writes; the streaming cap is covered by the chunked readJsonBody test below.)
 */
function postOversized(port: number, path: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", agent: false, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": String(MAX_BODY_BYTES + 1) } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      },
    );
    req.on("error", (err) => (req.destroyed ? undefined : reject(err)));
    req.flushHeaders();
  });
}

/** A raw POST, so a test controls the body bytes exactly (fetch would reject an oversized body only after sending it). */
function post(port: number, path: string, token: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      // A fresh socket per call, and no `connection: close`: a client that announced close would get its socket ended mid-upload.
      { host: "127.0.0.1", port, path, method: "POST", agent: false, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function syncFixture() {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'node-a', 'home', ?)").run(nodeId, now());
  const token = newId();
  db.prepare("INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at) VALUES (?, 'peer-b', 'https://b.example/sync', 'home', ?, ?)").run(
    newId(),
    sha256Hex(token),
    now(),
  );
  const server = await startSyncServer({ db, nodeId, listen: `127.0.0.1:${SYNC_PORT}` });
  closers.push(() => server.close());
  return { db, token };
}

async function mcpFixture() {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'node-a', 'home', ?)").run(nodeId, now());
  const token = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'codex', 'openai', ?, ?, ?)").run(newId(), nodeId, sha256Hex(token), now());
  const server = await startServer({ db, nodeId, listen: `127.0.0.1:${MCP_PORT}` });
  closers.push(() => server.close());
  return { db, token };
}

describe("sync listener request handling (#72)", () => {
  it("answers bad JSON on /v1/pull with 400, not 500", async () => {
    const { token } = await syncFixture();
    const res = await post(SYNC_PORT, "/v1/pull", token, "{not json");
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toEqual({ error: "Invalid JSON body" });
  });

  it("refuses a body over the cap with 413", async () => {
    const { token } = await syncFixture();
    expect(await postOversized(SYNC_PORT, "/v1/pull", token)).toBe(413);
  });

  it("returns a generic 500 with a request id, never the internal error message", async () => {
    const { db, token } = await syncFixture();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // Break the database after auth would read it: the next query throws a SQLite error.
    db.close();
    const res = await post(SYNC_PORT, "/v1/pull", token, JSON.stringify({ node: "n", vector: {}, limit: 10 }));
    expect(res.status).toBe(500);
    const body = JSON.parse(res.text) as { error: string; requestId: string };
    expect(body.error).toBe("internal error");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.text).not.toMatch(/database|sqlite/i);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(body.requestId));
  });
});

describe("MCP listener request handling (#72)", () => {
  it("refuses a body over the cap with 413", async () => {
    const { token } = await mcpFixture();
    expect(await postOversized(MCP_PORT, "/mcp", token)).toBe(413);
  });

  it("still answers bad JSON with 400", async () => {
    const { token } = await mcpFixture();
    const res = await post(MCP_PORT, "/mcp", token, "{not json");
    expect(res.status).toBe(400);
  });

  it("returns a generic 500 with a request id, never the internal error message", async () => {
    const { db, token } = await mcpFixture();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    db.close();
    const res = await post(MCP_PORT, "/mcp", token, "{}");
    expect(res.status).toBe(500);
    const body = JSON.parse(res.text) as { error: { message: string; requestId: string } };
    expect(body.error.message).toBe(`Internal error (request ${body.error.requestId})`);
    expect(res.text).not.toMatch(/database|sqlite/i);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(body.error.requestId));
  });
});

describe("MCP tool call failures (#72)", () => {
  it("answers an unexpected tool failure with a generic JSON-RPC error, never the internal message", async () => {
    const { db, token } = await mcpFixture();
    db.exec("DROP TABLE tool_metrics"); // the tool succeeds, then recording its metrics fails inside SQLite
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, connection: "close" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "context_search", arguments: { query: "anything" } } }),
    });
    const text = await res.text();
    expect(text).toMatch(/Internal error \(request [0-9a-f-]{36}\)/);
    expect(text).not.toMatch(/tool_metrics|no such table|sqlite/i);
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/tool_metrics/));
  });
});

describe("readJsonBody and server timeouts (#72)", () => {
  async function withEchoServer(maxBytes: number, run: (port: number) => Promise<void>): Promise<void> {
    const server: Server = createServer((req, res) => {
      readJsonBody(req, maxBytes).then(
        (value) => res.writeHead(200).end(JSON.stringify(value)),
        (err) => res.writeHead(err instanceof HttpBodyError ? err.status : 500).end(),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run((server.address() as { port: number }).port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("decodes a multi-byte character split across chunks", async () => {
    await withEchoServer(1024, async (port) => {
      const bytes = Buffer.from(JSON.stringify({ title: "café ☕" }));
      const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", headers: { connection: "close" } }, (r) => {
          let text = "";
          r.on("data", (c) => (text += c));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, text }));
        });
        req.on("error", reject);
        const split = bytes.indexOf(Buffer.from("☕")) + 1; // inside the 3-byte sequence
        req.write(bytes.subarray(0, split));
        setTimeout(() => req.end(bytes.subarray(split)), 20);
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({ title: "café ☕" });
    });
  });

  it("caps a chunked body with no content-length", async () => {
    await withEchoServer(16, async (port) => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", headers: { "transfer-encoding": "chunked", connection: "close" } }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        });
        req.on("error", reject);
        req.write("x".repeat(10));
        req.end("y".repeat(10));
      });
      expect(status).toBe(413);
    });
  });

  it("logs an internal error through the secret redactor (TS-AC-2)", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = "ghp_" + "a".repeat(36);
    const id = logInternalError(new Error(`failed with ${token}`));
    const line = logged.mock.calls[0]![0] as string;
    expect(line).toContain(id);
    expect(line).not.toContain(token);
  });

  it("sets header and request timeouts", () => {
    const server = createServer();
    applyServerTimeouts(server);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(30_000);
  });
});
