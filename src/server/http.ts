import type { IncomingMessage } from "node:http";

/** Shared by every loopback HTTP listener (MCP on 7411, sync on 7412): one body reader, one bearer-token rule, one "host:port" parse. */

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer | string) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** `Authorization: Bearer <token>` -> `<token>`, or undefined for any other (or missing) header. */
export function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

export function parseListen(listen: string): { host: string; port: number } {
  const colon = listen.lastIndexOf(":");
  return { host: listen.slice(0, colon), port: Number(listen.slice(colon + 1)) };
}
