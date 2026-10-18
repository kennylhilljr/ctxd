/** Entry kinds and statuses (PRD-knowledge-model-v1 section 3, SPEC v3 section 4). */
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
export const IMMUTABLE_KINDS: ReadonlySet<Kind> = new Set(["decision", "handoff", "pointer"]);

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
};

export type Replication = "all" | "home" | "local";
export type VendorPolicy = "any" | "local-only";
export type Vendor = "anthropic" | "openai" | "google" | "local" | "human" | "other";
export type NodeRole = "home" | "roaming";
export type AccessLevel = "none" | "read" | "propose" | "write";
export type ScopeKind = "project" | "me" | "profile" | "hold";
export const FLAG_PROBLEMS = ["wrong", "stale", "duplicate", "unsafe"] as const;
export type FlagProblem = (typeof FLAG_PROBLEMS)[number];
