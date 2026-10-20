/**
 * ctxd mobile inbox Worker (M7 slice 5; M7-plan-v1 section 2's recommendation). Deployed
 * separately from ctxd itself (an owner step; see wrangler.toml's own header). Write-only for
 * phone clients, outbound-pull-only for the hub: this file never reaches back into the home
 * network, and the hub's own token here can only pull and delete, never read ctxd's store.
 *
 * Minimal local types stand in for @cloudflare/workers-types (a devDependency here, not
 * installed by this file's own type-checking -- this project is outside ctxd's root
 * tsconfig.json, which only includes src/**\/*.ts).
 */

interface D1Result<T> {
  results: T[];
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface Env {
  DB: D1Database;
}

const MAX_BODY_BYTES = 16 * 1024; // MI-5
const MAX_PAYLOAD_BYTES = 32 * 1024; // MI-5
const MAX_QUEUE_DEPTH = 500; // threat model item 4
const RATE_LIMIT_PER_MINUTE = 10; // threat model item 1

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface TokenRow {
  role: "client" | "hub";
}

/** Bearer auth against the `tokens` table; null means "already answered with a 401 Response". */
async function authenticate(request: Request, env: Env, role: "client" | "hub"): Promise<Response | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return new Response("missing bearer token", { status: 401 });
  const row = await env.DB.prepare("SELECT role FROM tokens WHERE token_hash = ?")
    .bind(await sha256Hex(match[1] as string))
    .first<TokenRow>();
  if (!row || row.role !== role) return new Response("unauthorized", { status: 401 });
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** MI-5's size bounds, plus the structural fields every inbox entry needs (src/inbox/types.ts's inboxEntrySchema, mirrored loosely here -- the hub re-validates strictly on pull, this is only the edge's own defense). */
function validEntryShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.scope === "string" && typeof v.kind === "string" && typeof v.title === "string" && typeof v.body === "string" && typeof v.capturedAt === "string";
}

async function handleCapture(request: Request, env: Env, tokenHash: string): Promise<Response> {
  const nowMinute = Math.floor(Date.now() / 60_000);
  const limited = await env.DB.prepare("SELECT count FROM rate_limits WHERE token_hash = ? AND window_start = ?").bind(tokenHash, nowMinute).first<{ count: number }>();
  if (limited && limited.count >= RATE_LIMIT_PER_MINUTE) return new Response("rate limited", { status: 429 });

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_PAYLOAD_BYTES) return new Response("payload too large", { status: 413 });
  let entry: unknown;
  try {
    entry = JSON.parse(raw);
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (!validEntryShape(entry)) return new Response("invalid entry shape", { status: 400 });
  if (new TextEncoder().encode(entry.body as string).length > MAX_BODY_BYTES) return new Response("body too large", { status: 413 });

  const depth = await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox_entries").first<{ n: number }>();
  if ((depth?.n ?? 0) >= MAX_QUEUE_DEPTH) return new Response("inbox full", { status: 429 });

  await env.DB.prepare("INSERT INTO rate_limits (token_hash, window_start, count) VALUES (?, ?, 1) ON CONFLICT (token_hash, window_start) DO UPDATE SET count = count + 1").bind(
    tokenHash,
    nowMinute,
  ).run();
  const result = await env.DB.prepare("INSERT INTO inbox_entries (body, created_at) VALUES (?, ?) RETURNING id").bind(raw, new Date().toISOString()).first<{ id: number }>();
  return json({ id: String(result?.id) }, 201);
}

interface InboxEntryRow {
  id: number;
  body: string;
}

async function handlePull(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 500);
  const rows = (await env.DB.prepare("SELECT id, body FROM inbox_entries ORDER BY id ASC LIMIT ?").bind(limit + 1).all<InboxEntryRow>()).results;
  const page = rows.slice(0, limit);
  return json({
    entries: page.map((r) => ({ inboxEntryId: String(r.id), raw: JSON.parse(r.body) })),
    more: rows.length > limit,
  });
}

async function handleAck(request: Request, env: Env): Promise<Response> {
  const { ids } = (await request.json()) as { ids: string[] };
  for (const id of ids) {
    const n = Number(id);
    if (Number.isInteger(n)) await env.DB.prepare("DELETE FROM inbox_entries WHERE id = ?").bind(n).run();
  }
  return json({});
}

async function handleStatus(env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox_entries").first<{ n: number }>();
  return json({ pending: row?.n ?? 0 });
}

interface BriefInput {
  scope: string;
  payload: unknown;
}

/** MI-9 (slice 6): the hub pushes allowlisted briefs; the mobile app can only read them, never see raw ctxd content. */
async function handlePublishBriefs(request: Request, env: Env): Promise<Response> {
  const { briefs } = (await request.json()) as { briefs: BriefInput[] };
  const now = new Date().toISOString();
  for (const b of briefs) {
    await env.DB.prepare("INSERT INTO briefs (scope, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT (scope) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .bind(b.scope, JSON.stringify(b.payload), now)
      .run();
  }
  return json({});
}

async function handleReadBriefs(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare("SELECT scope, payload FROM briefs").all<{ scope: string; payload: string }>()).results;
  return json({ briefs: rows.map((r) => ({ scope: r.scope, payload: JSON.parse(r.payload) })) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/v1/inbox/entries") {
      const header = request.headers.get("authorization") ?? "";
      const match = /^Bearer (.+)$/.exec(header);
      const unauthorized = await authenticate(request, env, "client");
      if (unauthorized) return unauthorized;
      return handleCapture(request, env, await sha256Hex(match![1] as string));
    }
    if (request.method === "GET" && url.pathname === "/v1/inbox/pull") {
      return (await authenticate(request, env, "hub")) ?? handlePull(url, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/inbox/ack") {
      return (await authenticate(request, env, "hub")) ?? handleAck(request, env);
    }
    if (request.method === "GET" && url.pathname === "/v1/inbox/status") {
      return (await authenticate(request, env, "hub")) ?? handleStatus(env);
    }
    if (request.method === "POST" && url.pathname === "/v1/inbox/briefs") {
      return (await authenticate(request, env, "hub")) ?? handlePublishBriefs(request, env);
    }
    if (request.method === "GET" && url.pathname === "/v1/inbox/briefs") {
      return (await authenticate(request, env, "client")) ?? handleReadBriefs(env);
    }
    return new Response("not found", { status: 404 });
  },
};
