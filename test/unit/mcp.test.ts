import { createServer as createHttpServer, type Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { ensureServerRunning, probeServer } from "../../src/cli/mcp.js";

/** `ctxd mcp`/`ctxd stdio` (M5 slice 2): SPEC open issue 3's resolved design, "always proxy, and
 * start the server if it is absent." These tests use a bare http server standing in for a real
 * `ctxd server`, since ensureServerRunning only ever cares about GET /healthz -> 200; the
 * spawn step itself is injected, since a real spawn would try to run vitest's own entry point
 * as "ctxd server" under `process.argv[1]`. */

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
});

function fakeHealthzServer(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      if (req.url === "/healthz") res.writeHead(200).end("ok");
      else res.writeHead(404).end();
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function unusedPort(): number {
  return 20000 + Math.floor(Math.random() * 10000);
}

describe("probeServer", () => {
  it("resolves true when something answers GET /healthz with 200", async () => {
    const port = unusedPort();
    servers.push(await fakeHealthzServer(port));
    expect(await probeServer(`127.0.0.1:${port}`)).toBe(true);
  });

  it("resolves false when nothing is listening on the port", async () => {
    expect(await probeServer(`127.0.0.1:${unusedPort()}`)).toBe(false);
  });
});

describe("ensureServerRunning", () => {
  it("never spawns when the server is already up", async () => {
    const port = unusedPort();
    servers.push(await fakeHealthzServer(port));
    let spawned = false;
    await ensureServerRunning(`127.0.0.1:${port}`, "/unused", "/unused", () => {
      spawned = true;
    });
    expect(spawned).toBe(false);
  });

  it("spawns once and returns once the spawned server comes up", async () => {
    const port = unusedPort();
    let spawnCalls = 0;
    await ensureServerRunning(`127.0.0.1:${port}`, "/unused", "/unused", () => {
      spawnCalls++;
      // Simulates a real `ctxd server` taking a moment to bind its port after being spawned.
      setTimeout(() => {
        void fakeHealthzServer(port).then((s) => servers.push(s));
      }, 150);
    });
    expect(spawnCalls).toBe(1);
    expect(await probeServer(`127.0.0.1:${port}`)).toBe(true);
  });

  it("gives up after its timeout and returns anyway if the server never comes up", async () => {
    const port = unusedPort();
    let spawnCalls = 0;
    await ensureServerRunning(`127.0.0.1:${port}`, "/unused", "/unused", () => {
      spawnCalls++;
      // Deliberately never brings anything up.
    });
    expect(spawnCalls).toBe(1);
    expect(await probeServer(`127.0.0.1:${port}`)).toBe(false);
  }, 10000);
});
