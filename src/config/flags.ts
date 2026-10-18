import { CtxdError } from "../core/errors.js";

/**
 * Feature flag registry (PRD-feature-flags-v1, Spec v8 section 3.1): one entry per flag, with
 * its default, the milestone that introduced it, a description, its off-behavior and an optional
 * parent whose own "off" silences it regardless of its own value (FF-4). Nothing reads a flag
 * that is not listed here (FF-1); `sync`/`sync.serve` are added when replication lands later in
 * M3, not here, so the registry only ever lists flags whose feature already exists.
 */
export interface FlagDef {
  name: string;
  default: boolean;
  milestone: string;
  description: string;
  offMeans: string;
  parent?: string;
}

export const FLAG_REGISTRY: readonly FlagDef[] = [
  { name: "hooks", default: true, milestone: "M2", description: "Master switch for every hook", offMeans: "Every hook exits 0 at once (the master switch)" },
  { name: "hooks.session_start", default: true, milestone: "M2", description: "SessionStart and SubagentStart briefs", offMeans: "No brief injected at session start, resume, compaction or for subagents", parent: "hooks" },
  { name: "hooks.nudge", default: true, milestone: "M2", description: "Stop-hook handoff nudge", offMeans: "The Stop hook never blocks to ask for a handoff", parent: "hooks" },
  { name: "hooks.commit_journal", default: true, milestone: "M2", description: "Journal entry for a successful git commit", offMeans: "Commits are not recorded or journaled", parent: "hooks" },
  { name: "hooks.session_end", default: true, milestone: "M2", description: "SessionEnd journal entry and mechanical claim release", offMeans: "No session journal entry or mechanical claim release at session end", parent: "hooks" },
  { name: "hooks.checkpoint", default: true, milestone: "M2", description: "PreCompact checkpoint file", offMeans: "No PreCompact checkpoints", parent: "hooks" },
  { name: "hooks.crash_sweep", default: true, milestone: "M2", description: "Orphaned-session sweep at SessionStart", offMeans: "Orphaned sessions are left as they are", parent: "hooks" },
  { name: "hooks.path_guard", default: true, milestone: "M2", description: "PreToolUse block on ctxd's own data folder", offMeans: "File tools may touch ctxd's data folder", parent: "hooks" },
  { name: "hooks.prompt_search", default: false, milestone: "M2", description: "Read moment R7: search hints on each prompt", offMeans: "No search on each prompt (read moment R7)", parent: "hooks" },
  { name: "claims.mechanical_release", default: true, milestone: "M2", description: "Automatic claim release when a session's work is committed and clean", offMeans: "Claims are released only explicitly" },
  { name: "review.remembered_rules", default: true, milestone: "M2", description: "Review rules that auto-accept matching writes", offMeans: "Remembered approval rules are ignored; everything proposed waits for review" },
  { name: "metering", default: true, milestone: "M1", description: "Per-response size and token metering", offMeans: "Response sizes are not recorded" },
];

const FLAGS_BY_NAME = new Map(FLAG_REGISTRY.map((def) => [def.name, def]));

/** `hooks.nudge` -> `CTXD_FEATURE_HOOKS_NUDGE` (PRD-feature-flags-v1 section 2). */
export function envVarName(name: string): string {
  return `CTXD_FEATURE_${name.toUpperCase().replace(/\./g, "_")}`;
}

export type FlagSource = "default" | "config" | "environment";

export interface ResolvedFlag {
  def: FlagDef;
  value: boolean;
  source: FlagSource;
}

interface ConfigFeatures {
  features?: Record<string, boolean>;
}

function ownValueAndSource(def: FlagDef, config: ConfigFeatures | undefined, env: NodeJS.ProcessEnv): { value: boolean; source: FlagSource } {
  let value = def.default;
  let source: FlagSource = "default";
  const fromConfig = config?.features?.[def.name];
  if (typeof fromConfig === "boolean") {
    value = fromConfig;
    source = "config";
  }
  const fromEnv = env[envVarName(def.name)];
  if (fromEnv === "0") {
    value = false;
    source = "environment";
  } else if (fromEnv === "1") {
    value = true;
    source = "environment";
  }
  return { value, source };
}

/**
 * Every flag's effective value (registry default, then `[features]`, then the environment;
 * parent flags ANDed in) plus which layer decided its own setting, for `ctxd features`.
 */
export function resolveFlagsDetailed(config: ConfigFeatures | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedFlag[] {
  const own = new Map(FLAG_REGISTRY.map((def) => [def.name, ownValueAndSource(def, config, env)]));
  const effective = new Map<string, boolean>();
  function resolve(name: string): boolean {
    const cached = effective.get(name);
    if (cached !== undefined) return cached;
    const def = FLAGS_BY_NAME.get(name)!;
    const o = own.get(name)!;
    const value = o.value && (def.parent ? resolve(def.parent) : true);
    effective.set(name, value);
    return value;
  }
  return FLAG_REGISTRY.map((def) => ({ def, value: resolve(def.name), source: own.get(def.name)!.source }));
}

/** Just the effective values, for hot-path checks in hooks, the write path and the server. */
export function resolveFlags(config: ConfigFeatures | undefined, env: NodeJS.ProcessEnv = process.env): Map<string, boolean> {
  return new Map(resolveFlagsDetailed(config, env).map((r) => [r.def.name, r.value]));
}

/**
 * Unregistered names have no gate to fail: treat them as on (FF-1 keeps this from mattering in
 * practice). `flags` itself may be undefined: call sites that predate M3 (test fixtures that
 * build a HookContext/RequestContext/WriteContext literal without one) behave as if every flag
 * is on, matching their pre-M3 behavior exactly.
 */
export function isFlagOn(flags: Map<string, boolean> | undefined, name: string): boolean {
  return flags?.get(name) ?? true;
}

/** FF-7: a disabled feature's tool call fails with `NOT_ALLOWED` and this exact hint text. */
export function requireFlag(flags: Map<string, boolean> | undefined, name: string): void {
  if (!isFlagOn(flags, name)) {
    const hint = `Feature \`${name}\` is disabled on this machine.`;
    throw new CtxdError("NOT_ALLOWED", hint, {}, undefined, hint);
  }
}
