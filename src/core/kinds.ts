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
export type ScopeKind = "project" | "me" | "profile" | "hold";
export const FLAG_PROBLEMS = ["wrong", "stale", "duplicate", "unsafe"] as const;

/**
 * `_me`'s scope_id is this fixed constant, not a random id, on every node (PRD-replication-v4
 * section 1: "every machine works fully offline and converges with the others"). `_me` is the
 * one scope every `ctxd init` creates without a prior event to derive an id from (SPEC genesis
 * exception, src/cli/init.ts); giving it a random id per node would mean a person's own personal
 * scope never converges across their own machines, since nothing yet replicates scope identity
 * itself (that lands with ACL/scope metadata events, M3 slice 6). Every other scope is created
 * locally by name (`ctxd scope add`) and does not need this: cross-node convergence for named
 * project scopes is exactly what that later slice adds.
 */
export const ME_SCOPE_ID = "_me";
export type FlagProblem = (typeof FLAG_PROBLEMS)[number];
