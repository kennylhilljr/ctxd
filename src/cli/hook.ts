/**
 * `ctxd hook <event> --client <claude-code|codex> [--scope <name>]` (SPEC v6 section 9.1): the
 * single entry point every client's hook configuration calls. Reads the hook JSON from stdin,
 * checks bypass first, resolves scope, upserts the session row, and dispatches to a per-event
 * handler within a time budget. Exits 0 in every case except an intentional Stop block (9.1):
 * an unknown event, a misconfigured client, a missing database, or a handler that times out or
 * throws all fall through to "do nothing, exit 0" rather than breaking the calling session.
 *
 * M2 scope note: this slice is the plumbing only. HOOK_HANDLERS starts empty; later M2 slices
 * (path guard, crash sweep, read moments, write moments) register real handlers per event. Until
 * then every event upserts `sessions` and otherwise produces no output, which is itself correct
 * behavior (SPEC 9.1's "never breaks a session" applies even with no feature behind an event yet).
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir } from "./common.js";
import { loadConfig, type CtxdConfig } from "../config/config.js";
import { openDatabase } from "../store/db.js";
import { ADAPTERS, CTXD_HOOK_EVENTS, type CtxdHookEvent, type HookAdapter } from "../hooks/adapters.js";
import { isBypassed, resolveScope } from "../hooks/scope.js";
import { upsertSession } from "../hooks/sessions.js";

export interface HookContext {
  db: Database.Database;
  nodeId: string;
  clientId: string;
  clientName: string;
  adapter: HookAdapter;
  event: CtxdHookEvent;
  sessionRef: string;
  scope: string | null;
  scopeNotice: string | null;
  input: Record<string, unknown>;
  dataDir: string;
  config: CtxdConfig | undefined;
}

export type HookResult = { text?: string; block?: { reason: string } } | undefined;
export type HookHandlerFn = (ctx: HookContext) => Promise<HookResult> | HookResult;

/** Registry the hook CLI dispatches through. Later M2 slices replace these stubs with real behavior. */
export const HOOK_HANDLERS: Partial<Record<CtxdHookEvent, HookHandlerFn>> = {};

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    process.stdin.resume();
  });
}

/** Race `fn` against a deadline; on timeout, resolve to `undefined` rather than reject, so a slow handler never breaks the session. */
export function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    }, ms);
    fn().then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(undefined);
        }
      },
    );
  });
}

interface HookArgs {
  client?: string;
  scope?: string;
  "data-dir"?: string;
  config?: string;
}

/**
 * The dispatch logic against an already-open database: session upsert plus handler invocation.
 * Split out from `dispatch` so tests can exercise it directly against a scratch database,
 * without going through file-path resolution or opening a real `ctxd.db`.
 */
export async function dispatchWithDb(
  db: Database.Database,
  event: CtxdHookEvent,
  adapter: HookAdapter,
  clientName: string,
  scopeArg: string | undefined,
  processCwd: string,
  input: Record<string, unknown>,
  scopeMap: Record<string, string>,
  dataDir = "",
  config: CtxdConfig | undefined = undefined,
): Promise<HookResult> {
  const client = db.prepare("SELECT client_id FROM clients WHERE name = ?").get(clientName) as { client_id: string } | undefined;
  const node = db.prepare("SELECT node_id FROM nodes LIMIT 1").get() as { node_id: string } | undefined;
  if (!client || !node) return undefined;

  const sessionId = String(input[adapter.fields.sessionId] ?? "");
  if (!sessionId) return undefined;
  const sessionRef = `${clientName}:${sessionId}`;
  const cwd = String(input[adapter.fields.cwd] ?? processCwd);

  const scopeResult = scopeArg ? { scope: scopeArg } : resolveScope(db, cwd, scopeMap);
  const scopeRow = scopeResult.scope
    ? (db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(scopeResult.scope) as { scope_id: string } | undefined)
    : undefined;

  const sourceField = adapter.fields.source ? input[adapter.fields.source] : undefined;
  const triggerField = adapter.fields.trigger ? input[adapter.fields.trigger] : undefined;
  const clearRecovery = event === "session-start" && (sourceField === "startup" || triggerField === "startup" || (sourceField === undefined && triggerField === undefined));

  upsertSession(db, {
    sessionRef,
    clientId: client.client_id,
    scopeId: scopeRow?.scope_id ?? null,
    event,
    nodeId: node.node_id,
    clearRecovery,
  });

  const handler = HOOK_HANDLERS[event];
  if (!handler) return undefined;
  const ctx: HookContext = {
    db,
    nodeId: node.node_id,
    clientId: client.client_id,
    clientName,
    adapter,
    event,
    sessionRef,
    scope: scopeResult.scope,
    scopeNotice: "notice" in scopeResult ? scopeResult.notice : null,
    input,
    dataDir,
    config,
  };
  return await handler(ctx);
}

async function dispatch(
  event: CtxdHookEvent,
  adapter: HookAdapter,
  clientName: string,
  args: HookArgs,
  processCwd: string,
  input: Record<string, unknown>,
  config: CtxdConfig | undefined,
): Promise<HookResult> {
  const dataDir = resolveDataDir({ dataDir: args["data-dir"], configPath: args.config });
  let db: Database.Database;
  try {
    db = openDatabase(join(dataDir, "ctxd.db"));
  } catch {
    return undefined; // no ctxd data yet (e.g. before `ctxd init`): nothing to do, never breaks the session
  }
  try {
    return await dispatchWithDb(db, event, adapter, clientName, args.scope, processCwd, input, config?.scope_map ?? {}, dataDir, config);
  } finally {
    db.close();
  }
}

export async function run(argv: string[]): Promise<number> {
  const [eventArg, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { client: { type: "string" }, scope: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });

  // Bypass is checked first, before reading stdin fully or opening the database (SPEC 9.9): a
  // bypassed session must make zero server calls.
  const cwd = process.cwd();
  let config: CtxdConfig | undefined;
  try {
    config = loadConfig(resolveConfigPath({ configPath: values.config }));
  } catch {
    config = undefined; // no config yet (e.g. before `ctxd init`): bypass still works with no patterns configured
  }
  if (isBypassed(cwd, config?.hooks.bypass_patterns ?? [])) return 0;

  if (!eventArg || !(CTXD_HOOK_EVENTS as readonly string[]).includes(eventArg)) return 0; // unknown event: never break the client
  const event = eventArg as CtxdHookEvent;
  const clientName = values.client;
  const adapter = clientName ? ADAPTERS[clientName] : undefined;
  if (!clientName || !adapter) return 0; // misconfigured client: still exit 0

  const rawInput = (await withDeadline(1000, readStdin)) ?? "";
  let input: Record<string, unknown> = {};
  try {
    input = rawInput ? (JSON.parse(rawInput) as Record<string, unknown>) : {};
  } catch {
    input = {};
  }

  // SPEC 9.1: never more than 1 second of synchronous work for SessionStart and Stop; otherwise
  // 80% of the adapter's own default timeout for that event.
  const budgetMs = event === "session-start" || event === "stop" ? Math.min(1000, Math.round(adapter.limits.defaultTimeoutMs * 0.8)) : Math.round(adapter.limits.defaultTimeoutMs * 0.8);

  const result = await withDeadline(budgetMs, () => Promise.resolve(dispatch(event, adapter, clientName, values, cwd, input, config)));

  if (result?.block && adapter.events[event]?.canBlock) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: result.block.reason }));
    return 0;
  }
  if (result?.text && !(adapter.limits.outputIgnoredOn ?? []).includes(event)) {
    const format = adapter.events[event]?.output;
    if (format === "additional-context") {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: result.text } }));
    } else if (format === "stdout-text") {
      process.stdout.write(result.text);
    }
  }
  return 0;
}
