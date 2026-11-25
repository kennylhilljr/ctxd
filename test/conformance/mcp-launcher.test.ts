import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #81 through the real `ctxd mcp` stdio launcher (via `tsx`, as the hooks conformance runner does):
 * every request line on stdin gets exactly one JSON-RPC line on stdout carrying its id, a
 * notification gets none, and a server failure the listener answers with a plain `{ error }`
 * envelope arrives as a JSON-RPC error (SPEC 8.4 step 6, NFR-9). A loopback stand-in answers
 * `/healthz`, so the launcher never spawns a real server.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
let scratch: string;
let configPath: string;
let dataDir: string;
let server: Server;

function cli(args: string[]): void {
  const result = spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], { cwd: REPO_ROOT, env: { ...process.env, CTXD_BYPASS: "" }, encoding: "utf8", timeout: 20_000 });
  if (result.status !== 0) throw new Error(`ctxd ${args[0]} failed: ${result.stderr}`);
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ctxd-launcher-"));
  configPath = join(scratch, "config", "ctxd.toml");
  dataDir = join(scratch, "data");
  cli(["init", "--config", configPath, "--data-dir", dataDir]);
  cli(["client", "add", "sample-agent", "--vendor", "openai", "--config", configPath, "--data-dir", dataDir]);

  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") return void res.writeHead(200).end("ok");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: unknown; method: string };
      if (msg.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } })}\n\n`);
      } else {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Missing or invalid token" } }));
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const config = readFileSync(configPath, "utf8");
  if (!config.includes("127.0.0.1:7411")) throw new Error("expected the default MCP listen address in the generated config");
  writeFileSync(configPath, config.replace("127.0.0.1:7411", `127.0.0.1:${port}`));
}, 60_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(scratch, { recursive: true, force: true });
});

/** Writes `lines` to a running launcher, keeps stdin open until `expected` stdout lines arrive (bounded), then closes it. */
function runLauncher(lines: string[], expected: number): Promise<string[]> {
  return new Promise((done, fail) => {
    const child = spawn("npx", ["tsx", "src/cli/index.ts", "mcp", "--client", "sample-agent", "--config", configPath, "--data-dir", dataDir], {
      cwd: REPO_ROOT,
      env: { ...process.env, CTXD_BYPASS: "", CTXD_POOL: "" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    const finish = () => {
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      done(out.split("\n").filter(Boolean));
    };
    // A short grace period after the expected count, so an extra (wrong) line would still be seen.
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(finish, 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (!grace && out.split("\n").filter(Boolean).length >= expected) grace = setTimeout(finish, 500);
    });
    child.on("error", fail);
    child.stdin.write(lines.map((l) => l + "\n").join(""));
  });
}

describe("ctxd mcp stdio launcher (#81)", () => {
  it("answers each request with one correlated JSON-RPC line, and notifications with none", async () => {
    const out = await runLauncher(
      [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: "call-2", method: "tools/call", params: { name: "context_brief", arguments: {} } }),
        "{not json",
      ],
      3,
    );
    const byId = new Map(out.map((l) => JSON.parse(l) as { id: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }).map((r) => [r.id, r]));
    expect(out).toHaveLength(3);
    expect(byId.get(1)).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(byId.get("call-2")).toEqual({
      jsonrpc: "2.0",
      id: "call-2",
      error: { code: -32603, message: "Missing or invalid token", data: { httpStatus: 401, error: { code: "UNAUTHORIZED", message: "Missing or invalid token" } } },
    });
    expect(byId.get(null)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }, 30_000);
});
