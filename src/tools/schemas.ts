import { z } from "zod";
import { KINDS } from "../core/kinds.js";

/**
 * MCP tool contracts (SPEC section 8.2).
 * Descriptions are deliberately terse: the whole tools/list payload must stay under
 * about 1,500 tokens (PRD NFR-4). test/unit/tool-footprint.test.ts enforces this.
 */

const scope = z.string().min(1).max(80).describe("Scope name from your brief");
const kind = z.enum(KINDS);
const requestId = z.string().min(8).max(64).describe("Unique id for idempotent retries");
const session = z.string().max(64).optional().describe("Session value from your brief");

const link = z.object({
  type: z.enum(["file", "commit", "url", "entry"]),
  ref: z.string().min(1).max(500),
  note: z.string().max(200).optional(),
});

export const contextBriefInput = z.object({
  scope,
  size: z.enum(["micro", "normal", "full"]).default("normal"),
});

export const contextSearchInput = z.object({
  scope,
  query: z.string().min(1).max(500),
  kinds: z.array(kind).max(9).optional(),
  limit: z.number().int().min(1).max(20).default(8),
  max_tokens: z.number().int().min(200).max(4000).default(1000),
  include_proposed: z.boolean().default(true),
});

export const contextGetInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(10),
  max_tokens: z.number().int().min(500).max(8000).default(3000),
});

export const contextWriteInput = z.object({
  scope,
  kind,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  links: z.array(link).max(20).optional(),
  id: z.string().optional().describe("Entry id to update; omit to create"),
  expected_rev: z.string().optional().describe("Required with id"),
  supersedes: z.string().optional().describe("Entry id this replaces"),
  confirmed_by_user: z.boolean().optional(),
  session,
  request_id: requestId,
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
  ttl_minutes: z.number().int().min(15).max(1440).default(120),
  request_id: requestId.optional(),
});

export interface ToolContract {
  name: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
}

export const TOOLS: readonly ToolContract[] = [
  {
    name: "context_brief",
    description: "Compact brief for a scope: status, latest handoff, decisions, conventions, open tasks.",
    input: contextBriefInput,
  },
  {
    name: "context_search",
    description: "Search a scope. Returns previews; fetch full entries with context_get.",
    input: contextSearchInput,
  },
  {
    name: "context_get",
    description: "Fetch full entries by id, within a token budget.",
    input: contextGetInput,
  },
  {
    name: "context_write",
    description:
      "Create or update an entry. Updates need expected_rev. Decisions, handoffs and pointers are immutable: use supersedes.",
    input: contextWriteInput,
  },
  {
    name: "context_handoff",
    description: "Write a handoff (done, next, open questions) or read the latest ones.",
    input: contextHandoffInput,
  },
  {
    name: "context_claim",
    description: "Claim, release or list task leases so agents do not duplicate work.",
    input: contextClaimInput,
  },
];
