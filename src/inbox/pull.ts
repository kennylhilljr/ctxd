import type Database from "better-sqlite3";
import { HlcClock } from "../core/hlc.js";
import { sha256Hex } from "../core/hash.js";
import { isFlagOn } from "../config/flags.js";
import { recordRejection, writeEntry, type WriteContext } from "../store/write.js";
import { inboxEntrySchema, type InboxEntry, type InboxTransport } from "./types.js";
import { exclusionReason, loadScopeExclusionRow } from "./scopeExclusion.js";

/**
 * Hub pull engine (M7 kickoff section 2; PRD-mobile-inbox-v1 MI-3 to MI-7): at-least-once pull,
 * idempotent apply keyed by the transport's own `inboxEntryId` (never by anything inside the
 * untrusted payload), applied through the existing single write path (src/store/write.ts), which
 * already does redaction, access evaluation and the forced-`proposed`-or-held quarantine for a
 * client with only `propose` access. `writeEntry`'s own idempotency (client_id + request_id) is
 * what makes re-applying an already-applied entry a no-op, which is also what makes the crash
 * recovery property (MI-4) fall out for free: acking happens strictly after `writeEntry` returns
 * (so after its transaction committed), so a crash in between just means the next pull re-tries
 * an apply that will replay rather than duplicate.
 */

export interface InboxPullOutcome {
  fetched: number;
  applied: number;
  held: number;
  rejected: number;
  /** Not acked; left in the buffer for the next pull to retry (an unexpected failure, not a verdict on the entry itself). */
  errored: number;
}

const DEFAULT_LIMIT = 50;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 40;

/** MI-5: schema validation already happened; this is the separate, byte-exact size bound (zod's .max() counts UTF-16 code units, not bytes). */
export const INBOX_MAX_BODY_BYTES = 16 * 1024;
export const INBOX_MAX_PAYLOAD_BYTES = 32 * 1024;

/** Provenance (MI-8), carried as tags since entries has no generic metadata column: origin, capture time, and the external reference if the client gave one, ahead of whatever tags the entry itself declared. */
function provenanceTags(entry: InboxEntry): string[] {
  const tags = ["origin:mobile-inbox", `captured:${entry.capturedAt}`.slice(0, MAX_TAG_CHARS)];
  if (entry.clientRef) tags.push(`ref:${entry.clientRef}`.slice(0, MAX_TAG_CHARS));
  for (const raw of entry.tags ?? []) {
    if (tags.length >= MAX_TAGS) break;
    const t = raw.slice(0, MAX_TAG_CHARS);
    if (!tags.includes(t)) tags.push(t);
  }
  return tags.slice(0, MAX_TAGS);
}

/** A stable, bounded (requestId is 8 to 64 characters) idempotency key derived from the transport's own id, never from anything inside the payload. */
function requestIdFor(inboxEntryId: string): string {
  return `inbox-${sha256Hex(inboxEntryId).slice(0, 32)}`;
}

type EntryOutcome = "applied" | "held" | "rejected";

function applyOneInboxEntry(ctx: WriteContext, inboxEntryId: string, raw: unknown): EntryOutcome {
  const { db } = ctx;
  const parsed = inboxEntrySchema.safeParse(raw);
  if (!parsed.success) {
    recordRejection(db, { clientId: ctx.clientId, tool: "inbox_pull", code: "INBOX_INVALID_ENTRY", detail: parsed.error.issues[0]?.message });
    return "rejected";
  }
  const entry = parsed.data;

  const payloadBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
  const bodyBytes = Buffer.byteLength(entry.body, "utf8");
  if (payloadBytes > INBOX_MAX_PAYLOAD_BYTES || bodyBytes > INBOX_MAX_BODY_BYTES) {
    recordRejection(db, { clientId: ctx.clientId, tool: "inbox_pull", code: "INBOX_PAYLOAD_TOO_LARGE", detail: `payload ${payloadBytes}B, body ${bodyBytes}B` });
    return "rejected";
  }

  const scope = loadScopeExclusionRow(db, entry.scope);
  if (scope) {
    const reason = exclusionReason(scope);
    if (reason) {
      recordRejection(db, { clientId: ctx.clientId, scopeId: scope.id, tool: "inbox_pull", code: "INBOX_SCOPE_EXCLUDED", detail: reason });
      return "rejected";
    }
  }

  const result = writeEntry(ctx, {
    scope: entry.scope,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    tags: provenanceTags(entry),
    request_id: requestIdFor(inboxEntryId),
  } as never);
  return "held" in result ? "held" : "applied";
}

export async function runInboxPull(
  db: Database.Database,
  nodeId: string,
  clientId: string,
  transport: InboxTransport,
  flags: Map<string, boolean> | undefined,
  opts: { limit?: number } = {},
): Promise<InboxPullOutcome> {
  const outcome: InboxPullOutcome = { fetched: 0, applied: 0, held: 0, rejected: 0, errored: 0 };
  if (!isFlagOn(flags, "mobile_inbox")) return outcome; // M7 kickoff section 2: zero network calls with the flag off

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const ctx: WriteContext = { db, clock: new HlcClock(nodeId), nodeId, clientId, flags };

  let more = true;
  while (more) {
    const page = await transport.pull(limit);
    more = page.more;
    if (page.entries.length === 0) break;
    outcome.fetched += page.entries.length;

    const toAck: string[] = [];
    for (const item of page.entries) {
      try {
        const result = applyOneInboxEntry(ctx, item.inboxEntryId, item.raw);
        outcome[result]++;
        toAck.push(item.inboxEntryId); // a terminal verdict either way: safe to remove from the buffer
      } catch {
        outcome.errored++; // left in the buffer; the next pull retries it (MI-4)
      }
    }
    if (toAck.length > 0) await transport.ack(toAck);
  }
  return outcome;
}
