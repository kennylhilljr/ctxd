/**
 * `ctxd status` / `ctxd statusline` (SPEC v8 section 9.11, PRD-hooks-v5 section 7.2): connection
 * health, the scope in use, whether a brief is available, open claims and unsynced changes, as
 * one line for Claude Code's status line setting, or the same facts with detail for a terminal.
 * Reads only local state (a loopback GET /healthz aside); `statusline` keeps a 50 ms budget.
 *
 * "Brief available" is a current-state check (would a session starting now, in this scope, with
 * the hooks flags as they stand, get a brief?), not a record of whether any specific past session
 * actually got one: nothing persists that today, and adding a column for it would mean editing
 * `sessions` in `src/store/schema.ts`, a file the concurrent M3 sync-conflicts work is also
 * changing. Flagged here rather than guessed at or risked as a merge conflict.
 *
 * "Unsynced" (W3 closes the gap this comment used to describe): `peer_watermarks` now records
 * what this node's sync server has served each peer, so `countUnsynced` (src/sync/freshness.ts)
 * answers "how many of my own events are peers still missing" from local state. Still `0` when
 * there is nothing to sync (sync off, or no peers), never a fabricated number otherwise.
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir } from "./common.js";
import { type CtxdConfig, loadConfig } from "../config/config.js";
import { resolveFlags, isFlagOn } from "../config/flags.js";
import { openDatabase } from "../store/db.js";
import { resolveScope } from "../hooks/scope.js";
import { countUnsynced } from "../sync/freshness.js";

export interface StatusInfo {
  healthOk: boolean;
  scope: string | null;
  scopeNotice: string | null;
  briefAvailable: boolean;
  openClaims: number;
  unsynced: number;
  peerCount: number;
}

function healthzUrl(listen: string): string {
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(listen);
  const [host, port] = bracketed ? [bracketed[1]!, bracketed[2]!] : listen.split(":");
  const hostPart = host!.includes(":") ? `[${host}]` : host;
  return `http://${hostPart}:${port}/healthz`;
}

async function checkHealthz(listen: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(healthzUrl(listen), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface GatherStatusOptions {
  cwd: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function gatherStatus(db: Database.Database, config: CtxdConfig, opts: GatherStatusOptions): Promise<StatusInfo> {
  const flags = resolveFlags(config);
  const healthOk = await checkHealthz(config.mcp.listen, opts.fetchImpl ?? fetch, opts.timeoutMs ?? 300);

  const resolution = resolveScope(db, opts.cwd, config.scope_map);
  const scope = resolution.scope;
  const scopeNotice = resolution.scope === null ? resolution.notice : null;

  const briefAvailable = scope !== null && isFlagOn(flags, "hooks") && isFlagOn(flags, "hooks.session_start");

  let openClaims = 0;
  if (scope) {
    const scopeRow = db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(scope) as { scope_id: string } | undefined;
    if (scopeRow) {
      openClaims = (db.prepare("SELECT COUNT(*) AS n FROM leases WHERE scope_id = ? AND state = 'active'").get(scopeRow.scope_id) as { n: number }).n;
    }
  }

  const peerCount = (db.prepare("SELECT COUNT(*) AS n FROM peers WHERE revoked_at IS NULL").get() as { n: number }).n;
  const syncOn = isFlagOn(flags, "sync");
  const unsynced = !syncOn || peerCount === 0 ? 0 : countUnsynced(db);

  return { healthOk, scope, scopeNotice, briefAvailable, openClaims, unsynced, peerCount };
}

export function formatStatusLine(info: StatusInfo): string {
  const health = info.healthOk ? "●" : "○";
  const scopePart = info.scope ?? "no scope";
  const briefPart = `brief ${info.briefAvailable ? "✓" : "✗"}`;
  const claimsPart = `${info.openClaims} claim${info.openClaims === 1 ? "" : "s"}`;
  const syncPart = `${info.unsynced} unsynced`;
  return `ctxd ${health} ${scopePart} · ${briefPart} · ${claimsPart} · ${syncPart}`;
}

export function formatStatusDetail(info: StatusInfo): string {
  const lines = [
    `connection: ${info.healthOk ? "ok (GET /healthz)" : "unreachable (is ctxd server running?)"}`,
    `scope: ${info.scope ?? `none (${info.scopeNotice})`}`,
    `brief: ${info.briefAvailable ? "available" : "not available (no scope, or hooks/hooks.session_start is off)"}`,
    `claims: ${info.openClaims} open`,
    `sync: ${info.peerCount} peer(s); ${info.unsynced} unsynced`,
  ];
  return lines.join("\n");
}

interface CommonArgs {
  cwd: string;
  dataDir: string;
  configPath: string;
}

function parseCommonArgs(argv: string[]): CommonArgs {
  const { values } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, config: { type: "string" }, cwd: { type: "string" } },
    strict: true,
  });
  return {
    cwd: values.cwd ?? process.cwd(),
    dataDir: resolveDataDir({ dataDir: values["data-dir"], configPath: values.config }),
    configPath: resolveConfigPath({ configPath: values.config }),
  };
}

async function withStatus<T>(args: CommonArgs, fn: (info: StatusInfo) => T): Promise<T> {
  const config = loadConfig(args.configPath);
  const db = openDatabase(join(args.dataDir, "ctxd.db"));
  try {
    const info = await gatherStatus(db, config, { cwd: args.cwd });
    return fn(info);
  } finally {
    db.close();
  }
}

export async function runStatus(argv: string[]): Promise<number> {
  try {
    await withStatus(parseCommonArgs(argv), (info) => console.log(formatStatusDetail(info)));
    return 0;
  } catch (err) {
    console.error(`ctxd status: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Claude Code's statusLine command may pass its JSON input on stdin ({cwd} or {workspace:{current_dir}}); falls back to --cwd or process.cwd(). */
async function readStdinCwd(timeoutMs: number): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(data) as { cwd?: string; workspace?: { current_dir?: string } };
        resolve(parsed.workspace?.current_dir ?? parsed.cwd);
      } catch {
        resolve(undefined);
      }
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    process.stdin.resume();
  });
}

export async function runStatusline(argv: string[]): Promise<number> {
  const args = parseCommonArgs(argv);
  // PRD-feature-flags-v1: "statusline off -> ctxd statusline prints nothing." Checked before
  // touching stdin or the database, so turning it off also skips that work.
  try {
    if (!isFlagOn(resolveFlags(loadConfig(args.configPath)), "statusline")) return 0;
  } catch {
    // no config yet, or unreadable: fall through and let withStatus's own error path handle it
  }
  const stdinCwd = await readStdinCwd(30);
  if (stdinCwd) args.cwd = stdinCwd;
  try {
    await withStatus(args, (info) => console.log(formatStatusLine(info)));
    return 0;
  } catch {
    console.log("ctxd ○");
    return 0; // the status line must never block or error Claude Code's own render
  }
}
