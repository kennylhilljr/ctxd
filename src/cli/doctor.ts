/**
 * `ctxd doctor` (SPEC v8 section 12, PRD-trust-safety-v4 TS-17): the seven checks the spec lists
 * for diagnosing a node, each read-only. Printed as one line per check so a human can scan it;
 * exit code is 0 only if every check passes.
 *
 * "Last sync age" (one of the spec's own bullets, under peer reachability): W3 closes this,
 * using `peers.last_synced_at` (already recorded per peer by a successful pull) rather than
 * `sync_state`, which never carried a timestamp. Warns past `sync.stale_hours` (default 24).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import type Database from "better-sqlite3";
import { resolveConfigPath, resolveDataDir, tokensDir } from "./common.js";
import { type CtxdConfig, loadConfig } from "../config/config.js";
import { isFlagOn, resolveFlags } from "../config/flags.js";
import { checkDatabaseIntegrity, openDatabase } from "../store/db.js";
import { isModelCached, modelCacheDir } from "../embed/model.js";
import { peerSyncAges } from "../sync/freshness.js";
import {
  claudeCodeSettingsPath,
  codexConfigPath,
  isClaudeCodeHooksInstalled,
  isCodexHooksInstalled,
} from "./install-hooks.js";
import { backupsDir } from "./backup.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** `[::1]:7412` -> `::1`; `127.0.0.1:7411` -> `127.0.0.1` (matches configSchema's own `listen` shape). */
function hostOf(hostPort: string): string {
  const bracketed = /^\[(.+)\]:\d+$/.exec(hostPort);
  return bracketed ? bracketed[1]! : hostPort.replace(/:\d+$/, "");
}

export function checkBindAddresses(config: CtxdConfig): DoctorCheck {
  const listens = [config.mcp.listen, config.sync.listen];
  const bad = listens.filter((l) => !isLoopbackHost(hostOf(l)));
  return {
    name: "bind addresses",
    ok: bad.length === 0,
    detail: bad.length === 0 ? `loopback only (${listens.join(", ")})` : `non-loopback bind address(es): ${bad.join(", ")}`,
  };
}

export function checkTokenFilePermissions(configPath: string): DoctorCheck {
  const dir = tokensDir(configPath);
  if (!existsSync(dir)) return { name: "token file permissions", ok: true, detail: "no tokens directory yet" };
  const files = readdirSync(dir).filter((f) => f.endsWith(".token"));
  const loose = files.filter((f) => (statSync(join(dir, f)).mode & 0o077) !== 0);
  return {
    name: "token file permissions",
    ok: loose.length === 0,
    detail: loose.length === 0 ? `${files.length} token file(s), none readable by group or other` : `readable by group or other: ${loose.join(", ")}`,
  };
}

export function checkDatabaseHealth(db: Database.Database): DoctorCheck {
  const result = checkDatabaseIntegrity(db);
  return { name: "database integrity", ok: result.ok, detail: result.ok ? "PRAGMA quick_check: ok" : result.reason! };
}

interface StoredReviewRule {
  kind?: string;
  client?: string;
  confirmed_by_user?: boolean;
}

/** SPEC 10.4's own narrowness constraints: a rule must name a kind, must name a client or require confirmed_by_user, and never targets skill or preference. */
function ruleIsNarrow(rule: StoredReviewRule): boolean {
  if (!rule.kind || rule.kind === "skill" || rule.kind === "preference") return false;
  return rule.client !== undefined || rule.confirmed_by_user === true;
}

export function checkReviewRuleNarrowness(db: Database.Database): DoctorCheck {
  const scopes = db.prepare("SELECT name, review_policy FROM scopes").all() as { name: string; review_policy: string }[];
  const violations: string[] = [];
  for (const scope of scopes) {
    const parsed = JSON.parse(scope.review_policy) as unknown;
    if (!Array.isArray(parsed)) continue;
    parsed.forEach((rule, index) => {
      if (!ruleIsNarrow(rule as StoredReviewRule)) violations.push(`${scope.name}[${index}]`);
    });
  }
  return {
    name: "review rule narrowness",
    ok: violations.length === 0,
    detail: violations.length === 0 ? "every rule names a kind and a client or confirmed_by_user; none target skill or preference" : `broader than allowed: ${violations.join(", ")}`,
  };
}

export async function checkPeers(db: Database.Database, fetchImpl: typeof fetch = fetch, staleHours = 24): Promise<DoctorCheck> {
  const peers = db.prepare("SELECT name, url FROM peers WHERE revoked_at IS NULL").all() as { name: string; url: string }[];
  if (peers.length === 0) return { name: "peer reachability", ok: true, detail: "no peers configured" };

  const results = await Promise.all(
    peers.map(async (peer) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        await fetchImpl(peer.url, { signal: controller.signal });
        return { name: peer.name, reachable: true };
      } catch {
        return { name: peer.name, reachable: false };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  const unreachable = results.filter((r) => !r.reachable).map((r) => r.name);

  const ages = new Map(peerSyncAges(db, staleHours).map((a) => [a.name, a]));
  const stale = results.map((r) => r.name).filter((name) => ages.get(name)?.stale);
  const summary = results
    .map((r) => {
      const age = ages.get(r.name);
      const ageText = age ? (age.lastSyncedAt === null ? "never synced" : `last sync ${age.ageHours.toFixed(1)}h ago`) : "last sync unknown";
      return `${r.name}: ${r.reachable ? "reachable" : "unreachable"} (${ageText}${age?.stale ? ", STALE" : ""})`;
    })
    .join(", ");
  return {
    name: "peer reachability",
    ok: unreachable.length === 0 && stale.length === 0,
    detail: summary,
  };
}

export function checkFileVault(execFile: typeof execFileSync = execFileSync): DoctorCheck {
  try {
    const output = execFile("fdesetup", ["status"], { encoding: "utf8" }) as unknown as string;
    return { name: "FileVault", ok: /FileVault is On/i.test(output), detail: output.trim() };
  } catch (err) {
    return { name: "FileVault", ok: false, detail: `could not check: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Semantic search (SPEC v8 11.2): informational when off; flags the gap when on but the model is not cached, since search still runs but silently as keyword-only. */
export function checkSemanticSearch(config: CtxdConfig, dataDir: string): DoctorCheck {
  const on = isFlagOn(resolveFlags(config), "semantic_search");
  if (!on) return { name: "semantic search", ok: true, detail: "semantic_search is off; keyword search only" };
  const cached = isModelCached(dataDir);
  return {
    name: "semantic search",
    ok: cached,
    detail: cached
      ? "embedding model is cached; hybrid search is active"
      : `semantic_search is on but the embedding model is not cached at ${modelCacheDir(dataDir)}; search degrades to keyword-only. Run "ctxd model fetch".`,
  };
}

/** Age of the newest backup (W4), with a warning past `staleHours` (default 36). Informational, not failing, when `backups` is off. */
export function checkBackupAge(dataDir: string, config: CtxdConfig, staleHours = 36): DoctorCheck {
  if (!isFlagOn(resolveFlags(config), "backups")) return { name: "backup age", ok: true, detail: "backups is off" };

  const dir = backupsDir(dataDir);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".db.age")) : [];
  if (files.length === 0) return { name: "backup age", ok: false, detail: 'no backups yet; run "ctxd backup" or install the schedule (ctxd backup schedule install)' };

  const newestMs = Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs));
  const ageHours = (Date.now() - newestMs) / 3_600_000;
  return {
    name: "backup age",
    ok: ageHours < staleHours,
    detail: `newest backup ${ageHours.toFixed(1)}h old${ageHours >= staleHours ? " (stale)" : ""}`,
  };
}

export function checkHookInstallation(home: string = homedir()): DoctorCheck {
  const claudeCode = isClaudeCodeHooksInstalled(claudeCodeSettingsPath(home));
  const codex = isCodexHooksInstalled(codexConfigPath(home));
  const missing = [...(claudeCode ? [] : ["claude-code"]), ...(codex ? [] : ["codex"])];
  return {
    name: "hook installation",
    ok: missing.length === 0,
    detail: missing.length === 0 ? "claude-code and codex both have ctxd's hooks installed" : `missing for: ${missing.join(", ")}`,
  };
}

export interface DoctorOptions {
  configPath: string;
  dataDir: string;
  home?: string;
  fetchImpl?: typeof fetch;
  execFile?: typeof execFileSync;
}

export async function runDoctor(db: Database.Database, config: CtxdConfig, opts: DoctorOptions): Promise<DoctorCheck[]> {
  return [
    checkBindAddresses(config),
    checkTokenFilePermissions(opts.configPath),
    checkDatabaseHealth(db),
    checkReviewRuleNarrowness(db),
    await checkPeers(db, opts.fetchImpl, config.sync.stale_hours),
    checkFileVault(opts.execFile),
    checkHookInstallation(opts.home),
    checkSemanticSearch(config, opts.dataDir),
    checkBackupAge(opts.dataDir, config),
  ];
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { "data-dir": { type: "string" }, config: { type: "string" } }, strict: true });
  const configPath = resolveConfigPath({ configPath: values.config });
  if (!existsSync(configPath)) {
    console.error(`ctxd doctor: no config found at ${configPath}. Run "ctxd init" first.`);
    return 1;
  }
  const config = loadConfig(configPath);
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const dbPath = join(dataDir, "ctxd.db");
  if (!existsSync(dbPath)) {
    console.error(`ctxd doctor: ${dbPath} is missing. Run "ctxd restore <file>" from a backup.`);
    return 1;
  }
  let db: Database.Database;
  try {
    db = openDatabase(dbPath);
  } catch (err) {
    console.error(`ctxd doctor: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const checks = await runDoctor(db, config, { configPath, dataDir });
  db.close();

  let allOk = true;
  for (const check of checks) {
    console.log(`${check.ok ? "OK  " : "FAIL"} ${check.name}: ${check.detail}`);
    if (!check.ok) allOk = false;
  }
  return allOk ? 0 : 1;
}
