import { notImplemented } from "../core/todo.js";

/**
 * MCP Streamable HTTP server on 127.0.0.1 (SPEC sections 1 and 8), plus /internal routes
 * for the hook and admin CLI (8.3) and GET /healthz (12). Must call assertLoopback first.
 * Milestone M1.
 */
export async function startServer(): Promise<void> {
  notImplemented("startServer", "M1");
}
