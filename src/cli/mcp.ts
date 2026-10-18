/**
 * `ctxd mcp --client <id>`: the stdio MCP launcher every client starts from its single,
 * user-level MCP entry (SPEC v6 section 8.4). Resolves the session's persona, reads its
 * token from the Keychain (held only in memory here, never on disk/env/logs), and proxies
 * MCP messages between stdio and the local HTTP server over loopback.
 *
 * M1 scope note: resolveScope's git-origin lookup lands with hooks in M2, so persona
 * resolution here uses only CTXD_POOL and an explicit --scope; it also assumes `ctxd server`
 * is already running (launchd auto-start is an M4 operational concern), and fails with a
 * clear message if it isn't.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir, tokensDir } from "./common.js";
import { loadConfig } from "../config/config.js";
import { openDatabase } from "../store/db.js";
import { readSecret } from "../access/keychain.js";

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

/** The request id from a JSON-RPC line, or undefined if it's unparseable or a notification (no id). */
function parseRequestId(line: string): string | number | undefined {
  try {
    const parsed = JSON.parse(line) as { id?: string | number };
    return parsed.id;
  } catch {
    return undefined;
  }
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

/** Forward one line (a JSON-RPC message) to the server; returns the response line, or null for a notification. */
function proxyLine(listen: string, token: string, line: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const colon = listen.lastIndexOf(":");
    const host = listen.slice(0, colon);
    const port = Number(listen.slice(colon + 1));
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
        res.on("data", (chunk: Buffer | string) => (data += chunk));
        res.on("end", () => {
          const contentType = res.headers["content-type"] ?? "";
          if (contentType.includes("text/event-stream")) {
            const messages = parseSseMessages(data);
            resolve(messages.length ? messages[messages.length - 1]! : null);
          } else {
            resolve(data.trim().length > 0 ? data : null);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(line);
  });
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
        proxyLine(listen, token, line)
          .then((responseLine) => {
            if (responseLine !== null) process.stdout.write(responseLine.trimEnd() + "\n");
          })
          .catch((err: Error) => {
            console.error(`ctxd mcp: ${err.message}. Is "ctxd server" running?`);
            // SPEC v6 NFR-9 ("fail open for reads"): a request that gets no response at all
            // would hang the calling client forever waiting for it. Always answer, even when
            // the server is unreachable, so the agent can proceed without ctxd instead of stalling.
            const responseId = parseRequestId(line);
            if (responseId !== undefined) {
              process.stdout.write(
                JSON.stringify({ jsonrpc: "2.0", id: responseId, error: { code: -32000, message: `ctxd server unreachable: ${err.message}` } }) +
                  "\n",
              );
            }
          });
      }
    });
    process.stdin.on("end", () => resolve(0));
  });
}
