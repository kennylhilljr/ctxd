/** Entry kinds and statuses (PRD-knowledge-model-v3 section 3, SPEC v6 sections 4 and 4.3). */
export const KINDS = [
  "brief",
  "status",
  "decision",
  "convention",
  "fact",
  "lesson",
  "handoff",
  "task",
  "pointer",
  "note",
  "preference",
  "skill",
  "journal",
] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = [
  "active",
  "proposed",
  "flagged",
  "quarantined",
  "superseded",
  "archived",
  "conflicted",
  "deleted",
] as const;
export type Status = (typeof STATUSES)[number];

/** Kinds whose content cannot be updated after creation (SPEC section 4). */
export const IMMUTABLE_KINDS: ReadonlySet<Kind> = new Set(["decision", "handoff", "pointer", "journal"]);

/** Default status for agent-written entries (SPEC section 6, step 6). */
export const DEFAULT_AGENT_STATUS: Record<Kind, Status> = {
  brief: "proposed",
  status: "active",
  decision: "proposed",
  convention: "proposed",
  fact: "proposed",
  lesson: "proposed",
  handoff: "active",
  task: "active",
  pointer: "active",
  note: "active",
  preference: "proposed",
  skill: "proposed",
  journal: "active",
};

/** Kinds an agent can never get auto-accepted, whatever the review rules say (SPEC v6 10.4). */
export const ALWAYS_REVIEWED_KINDS: ReadonlySet<Kind> = new Set(["preference", "skill"]);

/** Spec v8 7.4: "Content of status, brief" is last-writer-wins on a concurrent sync conflict; every other mutable kind moves the entry to `conflicted` instead. */
export const LWW_CONTENT_KINDS: ReadonlySet<Kind> = new Set(["status", "brief"]);

/** Journal significance (SPEC v6 4.3). */
export const SIGNIFICANCES = ["routine", "milestone", "breakthrough", "blocker", "incident", "decision"] as const;
export type Significance = (typeof SIGNIFICANCES)[number];

/** Typed relations (SPEC v6 4.1). */
export const RELATION_TYPES = [
  "supersedes",
  "implements",
  "derived_from",
  "blocks",
  "relates_to",
  "points_to",
  "caused",
  "resolved",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Default status for an agent write of this kind, given its significance (SPEC v6 6, step 6). */
export function defaultAgentStatus(kind: Kind, significance?: Significance): Status {
  if (kind === "journal" && significance === "decision") return "proposed";
  return DEFAULT_AGENT_STATUS[kind];
}

export type Replication = "all" | "home" | "local";
export const REPLICATIONS: readonly Replication[] = ["all", "home", "local"];
export type VendorPolicy = "any" | "local-only";
export const VENDOR_POLICIES: readonly VendorPolicy[] = ["any", "local-only"];
export type Vendor = "anthropic" | "openai" | "google" | "local" | "human" | "other";
export const VENDORS: readonly Vendor[] = ["anthropic", "openai", "google", "local", "human", "other"];
export type NodeRole = "home" | "roaming";
export type AccessLevel = "none" | "read" | "propose" | "write";
/** Levels a grant or pool can hold (excludes "none", which means no grant at all). */
export const GRANT_LEVELS: readonly Exclude<AccessLevel, "none">[] = ["read", "propose", "write"];
export type ScopeKind = "project" | "me" | "profile" | "hold" | "system";
export const FLAG_PROBLEMS = ["wrong", "stale", "duplicate", "unsafe"] as const;

/**
 * `_me`'s scope_id is this fixed constant, not a random id, on every node (PRD-replication-v4
 * section 1: "every machine works fully offline and converges with the others"). `_me` is the
 * one scope every `ctxd init` creates without a prior event to derive an id from (SPEC genesis
 * exception, src/cli/init.ts); giving it a random id per node would mean a person's own personal
 * scope never converges across their own machines. Every other named scope now converges too,
 * without needing its own fixed constant: `core/ids.ts`'s `deterministicId` derives its id from
 * its name (M3 slice 6, Spec v8 4).
 */
export const ME_SCOPE_ID = "_me";

/**
 * Access metadata (scope creation, pool creation/membership/grants, client grants, review
 * policy) replicates as `acl` events whose `scope_id` is always this fixed constant (Spec v8 4:
 * "the reserved _system scope"), never the entity's own id, so `src/sync/pull.ts`'s replication
 * filter (joined on `events.scope_id`) has a real row to find: an acl event's `entry_id` is the
 * entity's own id, but a brand-new scope or pool doesn't exist in `scopes`/`pools` yet at the
 * moment its own creation event is in flight. `ctxd init` creates `_system` the same genesis-
 * exception way it creates `_me`, with replication `all` (every node needs the whole access
 * picture) and vendor policy `local-only`: by itself, that only excludes a non-`local`-vendor
 * agent outright, the same as any other `local-only` scope (`src/access/level.ts`'s `accessLevel`
 * rule 5); it does not, on its own, stop the human from granting `_system` access to some other
 * client via a pool or client grant. `src/cli/pool.ts` and `src/cli/grant.ts` refuse to resolve
 * `_system` as a grant target at all (found missing during `/code-review`), which is the actual
 * enforcement that keeps this scope acl-events-only.
 */
export const SYSTEM_SCOPE_ID = "_system";
export type FlagProblem = (typeof FLAG_PROBLEMS)[number];
