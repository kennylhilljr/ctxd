import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

/**
 * Two real `ctxd` processes converging over a real HTTP sync listener (Spec v8 7.1), the M3
 * exit criterion's minimal case: node A writes locally, node B pulls from A's listener and ends
 * up with the same entry. `CTXD_BYPASS` is cleared for the same reason test/conformance/hooks.test.ts
 * clears it: this sandbox's ambient shell may set it, which has nothing to do with sync but would
 * otherwise make `ctxd server`'s own hook-adjacent paths behave unexpectedly under test.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const MCP_PORT = 18411;
const SYNC_PORT = 18412;

interface Node {
  name: string;
  configPath: string;
  dataDir: string;
  syncUrl: string;
}

function run(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, CTXD_BYPASS: "", ...env },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1 };
}

function initNode(name: string, mcpPort: number, syncPort: number): Node {
  const scratch = mkdtempSync(join(tmpdir(), `ctxd-sync-${name}-`));
  const configPath = join(scratch, "config", "ctxd.toml");
  const dataDir = join(scratch, "data");
  const init = run(["init", "--config", configPath, "--data-dir", dataDir, "--name", name, "--role", "home"]);
  expect(init.status, init.stderr).toBe(0);

  const config = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  (config.mcp as Record<string, unknown>).listen = `127.0.0.1:${mcpPort}`;
  (config.sync as Record<string, unknown>).listen = `127.0.0.1:${syncPort}`;
  writeFileSync(configPath, stringify(config));

  return { name, configPath, dataDir, syncUrl: `http://127.0.0.1:${syncPort}` };
}

function addPeer(node: Node, peerName: string, peerUrl: string, token?: string): { stdout: string; stderr: string; status: number } {
  const args = ["node", "add-peer", peerName, peerUrl, "--role", "home", "--config", node.configPath, "--data-dir", node.dataDir];
  if (token) args.push("--token", token);
  return run(args);
}

/** The raw token `ctxd node add-peer` just generated, read from the token file it printed. */
function generatedTokenFor(node: Node, peerName: string): string {
  return readFileSync(join(node.configPath, "..", "tokens", `peer-${peerName}.token`), "utf8");
}

function remember(node: Node, text: string): { ref: string } {
  const result = run(["remember", text, "--scope", "_me", "--config", node.configPath, "--data-dir", node.dataDir]);
  expect(result.status, result.stderr).toBe(0);
  const match = /ctxd remember: (\S+)/.exec(result.stdout);
  if (!match) throw new Error(`could not parse ref from: ${result.stdout}`);
  return { ref: match[1]! };
}

function entryByTitle(dataDir: string, title: string): { title: string; body: string } | undefined {
  const db = new Database(join(dataDir, "ctxd.db"), { readonly: true });
  try {
    return db.prepare("SELECT title, body FROM entries WHERE title = ?").get(title) as { title: string; body: string } | undefined;
  } finally {
    db.close();
  }
}

describe("sync: two real nodes converge over a real HTTP listener", () => {
  let a: Node;
  let b: Node;
  let serverA: ReturnType<typeof spawn> | undefined;
  let serverAOutput = "";
  let validTokenForA = "";

  beforeAll(async () => {
    a = initNode("sync-test-node-a", MCP_PORT, SYNC_PORT);
    b = initNode("sync-test-node-b", MCP_PORT + 10, SYNC_PORT + 10);

    // A generates the token B must present; B generates the token A must present and supplies
    // A's token as its own outgoing one; A's own peer record for B is updated with B's token
    // (the three-call bootstrap src/cli/node.ts documents).
    addPeer(a, "sync-test-node-b", b.syncUrl);
    const tokenForBToUseOnA = generatedTokenFor(a, "sync-test-node-b");
    addPeer(b, "sync-test-node-a", a.syncUrl, tokenForBToUseOnA);
    const tokenForAToUseOnB = generatedTokenFor(b, "sync-test-node-a");
    addPeer(a, "sync-test-node-b", b.syncUrl, tokenForAToUseOnB);
    validTokenForA = tokenForBToUseOnA;

    // Only A's sync listener needs to run for this test: B pulls from A one-shot via the CLI.
    // CTXD_FEATURE_SYNC=1 is both the master switch and (sync.serve defaulting on) what turns
    // the listener on; there is no "serve but never pull" flag combination, by design (a server
    // with no peer to pull from just never has anything for its own interval loop to do).
    serverA = spawn("npx", ["tsx", "src/cli/index.ts", "server", "--config", a.configPath, "--data-dir", a.dataDir], {
      cwd: REPO_ROOT,
      env: { ...process.env, CTXD_BYPASS: "", CTXD_FEATURE_SYNC: "1" },
    });
    serverA.stdout?.on("data", (d: Buffer) => (serverAOutput += d.toString()));
    serverA.stderr?.on("data", (d: Buffer) => (serverAOutput += d.toString()));
    try {
      await waitForListener(SYNC_PORT);
    } catch (err) {
      throw new Error(`${(err as Error).message}\nnode A's server output so far:\n${serverAOutput}`);
    }
  }, 30_000);

  afterAll(() => {
    serverA?.kill("SIGTERM");
  });

  it("B pulls A's locally-written entry and ends up with the same content", () => {
    const text = "sync e2e: this line should reach node B";
    remember(a, text);

    const sync = run(["sync", "--peer", "sync-test-node-a", "--config", b.configPath, "--data-dir", b.dataDir]);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.stdout).toContain("1 applied");

    const onB = entryByTitle(b.dataDir, text);
    expect(onB?.body).toBe(text);
  });

  it("a second sync with nothing new applies zero events", () => {
    const sync = run(["sync", "--peer", "sync-test-node-a", "--config", b.configPath, "--data-dir", b.dataDir]);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.stdout).toContain("0 applied");
  });

  it("rejects a pull with no bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${SYNC_PORT}/v1/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "nobody", vector: {}, limit: 10 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an authenticated pull with vector: null as a 400, not a 500 (regression)", async () => {
    const res = await fetch(`http://127.0.0.1:${SYNC_PORT}/v1/pull`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${validTokenForA}` },
      body: JSON.stringify({ node: "sync-test-node-b", vector: null, limit: 10 }),
    });
    expect(res.status).toBe(400);
  });
});

async function waitForListener(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/v1/pull`, { method: "POST", body: "{}" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`sync listener on ${port} did not come up in time`);
}
