import { z } from "zod";
import { KINDS } from "../core/kinds.js";

/**
 * Mobile inbox entry shapes and the transport abstraction (M7 kickoff section 2; PRD-mobile-
 * inbox-v1 MI-1, MI-2, MI-5). An `InboxEntry` is untrusted input from a phone client: it is
 * schema-validated and size-bounded here, before anything else (redaction, access evaluation)
 * runs on it in src/inbox/pull.ts.
 */

/** MI-5: 16 KB body text, 32 KB total payload. */
export const INBOX_MAX_BODY_BYTES = 16 * 1024;
export const INBOX_MAX_PAYLOAD_BYTES = 32 * 1024;

export const inboxEntrySchema = z.object({
  /** Client-assigned or content-derived; the key idempotent apply and crash recovery key on (MI-3, MI-4). */
  inboxEntryId: z.string().min(1).max(200),
  scope: z.string().min(1).max(200),
  kind: z.enum(KINDS),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  /** External message reference, e.g. a chat message id (MI-8). */
  clientRef: z.string().min(1).max(200).optional(),
  capturedAt: z.string().min(1),
});
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

export interface InboxPullPage {
  entries: InboxEntry[];
  more: boolean;
}

export interface InboxStatus {
  pending: number;
}

/** MI-1: provider-neutral; a fake (tests), local-directory (offline development) and Cloudflare Worker adapter all implement this. */
export interface InboxTransport {
  pull(limit: number): Promise<InboxPullPage>;
  /** Deletes acknowledged entries from the buffer. Called only after the hub's own write transaction for each one has committed (MI-3). */
  ack(inboxEntryIds: readonly string[]): Promise<void>;
  status(): Promise<InboxStatus>;
}

/** One scope's brief, ready to publish (MI-9); `payload` is whatever src/brief/assemble.ts returned. */
export interface InboxBrief {
  scope: string;
  payload: unknown;
}

/** Slice 6: optional, separate from pulling. Only a transport backing `mobile_inbox.publish_briefs` needs it. */
export interface BriefPublishTransport {
  publishBriefs(briefs: readonly InboxBrief[]): Promise<void>;
}
