import { z } from "zod";
import { FLAG_PROBLEMS, KINDS, RELATION_TYPES, SIGNIFICANCES } from "../core/kinds.js";

/**
 * MCP tool contracts (SPEC v6 section 8.2).
 * Descriptions are deliberately terse: the whole tools/list payload must stay under
 * about 1,500 tokens (PRD NFR-4). test/unit/tool-footprint.test.ts enforces this.
 */

const scope = z.string().min(1).max(80).describe("Scope name from your brief");
const kind = z.enum(KINDS);
const requestId = z.string().min(8).max(64).describe("Unique id for idempotent retries");
const session = z.string().max(64).optional().describe("Session value from your brief");

/** Typed relation (SPEC v6 section 4.1). points_to targets are file:, commit: or url: references. */
const link = z.object({
  type: z.enum(RELATION_TYPES),
  ref: z.string().min(1).max(500),
  note: z.string().max(200).optional(),
});

export const contextBriefInput = z.object({
  scope,
  size: z.enum(["micro", "normal", "full"]).default("normal"),
});

const when = z.string().min(2).max(25);

export const contextSearchInput = z.object({
  scope: z.string().min(1).max(80).optional().describe('Scope, or "*" for all; required unless path'),
  query: z.string().min(1).max(500),
  path: z.string().min(7).max(300).optional().describe("ctxd:// folder to search in"),
  kinds: z.array(kind).max(10).optional(),
  since: when.optional().describe("ISO date or age, e.g. 7d"),
  until: when.optional(),
  limit: z.number().int().min(1).max(20).default(8),
  max_tokens: z.number().int().min(200).max(4000).default(1000),
  include_proposed: z.boolean().default(true),
});

export const contextGetInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(10).describe("Ids, ctxd: refs, ctxd:// paths or skill:<name>"),
  related: z.boolean().default(false).describe("Include one-hop related entries"),
  max_tokens: z.number().int().min(500).max(8000).default(3000),
});

export const contextWriteInput = z.object({
  scope,
  kind,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000).optional().describe("Required except for journal"),
  summary: z.string().min(1).max(200).optional(),
  significance: z.enum(SIGNIFICANCES).optional().describe("Journal only"),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  links: z.array(link).max(20).optional(),
  id: z.string().optional().describe("To update; omit to create"),
  expected_rev: z.string().optional().describe("Required with id"),
  supersedes: z.string().optional(),
  confirmed_by_user: z.boolean().optional(),
  session,
  request_id: requestId,
}).superRefine((v, ctx) => {
  // Kind rules from SPEC v6 4.3 and 6, step 3. Refinements do not appear in tool definitions.
  if (v.kind !== "journal" && v.body === undefined) {
    ctx.addIssue({ code: "custom", path: ["body"], message: "body is required except for journal" });
  }
  if (v.kind !== "journal" && v.significance !== undefined) {
    ctx.addIssue({ code: "custom", path: ["significance"], message: "significance is only for journal" });
  }
  if (v.kind === "journal" && v.body !== undefined && v.body.length > 1000) {
    ctx.addIssue({ code: "custom", path: ["body"], message: "journal body is at most 1,000 characters" });
  }
});

export const contextHandoffInput = z.object({
  scope,
  action: z.enum(["write", "latest"]),
  done: z.string().max(4000).optional(),
  next: z.string().max(4000).optional(),
  open_questions: z.string().max(2000).optional(),
  session,
  request_id: requestId.optional().describe("Required for write"),
});

export const contextClaimInput = z.object({
  scope,
  action: z.enum(["claim", "release", "list"]),
  task_id: z.string().optional(),
  title: z.string().min(1).max(200).optional().describe("Creates the task if new"),
  paths: z
    .array(z.string().min(1).max(512))
    .max(50)
    .optional()
    .describe("Repo-relative globs you expect to change; [] = no writes"),
  take_over: z.boolean().optional().describe("Take over a stale claim after checking its facts"),
  changed_files: z.array(z.string().min(1).max(512)).max(500).optional().describe("On release"),
  ttl_minutes: z.number().int().min(15).max(1440).default(120),
  session,
  request_id: requestId.optional(),
});

export const contextFlagInput = z.object({
  ref: z.string().min(1).describe("Entry id or ctxd: reference"),
  problem: z.enum(FLAG_PROBLEMS),
  reason: z.string().min(1).max(300),
  request_id: requestId.optional(),
});

export interface ToolContract {
  name: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
}

export const TOOLS: readonly ToolContract[] = [
  {
    name: "context_brief",
    description: "Compact brief for a scope: signals, status, handoff, decisions, conventions, tasks, skills.",
    input: contextBriefInput,
  },
  {
    name: "context_search",
    description: "Search a scope or folder. Returns previews; fetch full entries with context_get.",
    input: contextSearchInput,
  },
  {
    name: "context_get",
    description: "Fetch full entries, folders or skills, within a token budget.",
    input: contextGetInput,
  },
  {
    name: "context_write",
    description:
      "Create or update an entry. Updates need expected_rev. Decisions, handoffs, pointers and journal entries are immutable.",
    input: contextWriteInput,
  },
  {
    name: "context_handoff",
    description: "Write a handoff (done, next, open questions) or read the latest ones.",
    input: contextHandoffInput,
  },
  {
    name: "context_flag",
    description: "Flag an entry contradicted by code, the user or facts; it leaves briefs until reviewed.",
    input: contextFlagInput,
  },
  {
    name: "context_claim",
    description: "Claim, release or list tasks. Pass paths to detect overlap with other agents' claims.",
    input: contextClaimInput,
  },
];
