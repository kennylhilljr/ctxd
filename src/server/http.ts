import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { sanitizeCapture } from "../security/redact.js";

/** Shared by every loopback HTTP listener (MCP on 7411, sync on 7412): one body reader, one bearer-token rule, one "host:port" parse. */

/** The largest JSON request body either listener accepts (#72). A sync pull or MCP call is a few KiB; 4 MiB leaves room for a large entry body. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A request body this listener will not process: 413 when it is over the cap, 400 when it is not valid JSON. */
export class HttpBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}

export function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume(); // drain and discard the body, so the caller's 413 reaches a client that is still sending
      reject(new HttpBodyError(413, "Request body too large"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        done = true; // keep draining (and discarding) the rest; requestTimeout bounds a client that never stops
        chunks.length = 0;
        reject(new HttpBodyError(413, "Request body too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const data = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        reject(new HttpBodyError(400, "Invalid JSON body"));
      }
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/**
 * Bounds how long a client may take to send its headers and its whole request (#72), so a slow or
 * stalled peer cannot hold a socket open indefinitely. Responses are not affected: an MCP call that
 * takes a while to answer still completes.
 */
export function applyServerTimeouts(server: Server): void {
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
}

/**
 * An unexpected failure: logged locally with a request id, answered with only that id, so SQLite
 * or filesystem details never reach the caller (#72). Returns the id for tests and callers.
 */
export function logInternalError(err: unknown): string {
  const requestId = randomUUID();
  // Through the sanitizer like every other log line (TS-9): an error message can quote content or a credential.
  const detail = sanitizeCapture(err instanceof Error ? (err.stack ?? err.message) : String(err), 4000);
  console.error(`ctxd server: internal error ${requestId}: ${detail}`);
  return requestId;
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
