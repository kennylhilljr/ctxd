import type Database from "better-sqlite3";
import { HlcClock } from "../core/hlc.js";
import { isFlagOn } from "../config/flags.js";
import { assembleBrief } from "../brief/assemble.js";
import type { RequestContext } from "../server/context.js";
import { exclusionReason, loadScopeExclusionRow } from "./scopeExclusion.js";
import type { BriefPublishTransport, InboxBrief } from "./types.js";

/**
 * MI-9 (slice 6): push a `micro` brief for each owner-allowlisted scope (`config.inbox.
 * publish_scopes`, D2's default empty) to the cloud inbox, so a mobile assistant has minimal
 * context. Reuses the existing `context_brief` assembly (src/brief/assemble.ts) exactly as a
 * normal brief call would produce it; the only new logic here is the hard exclusion the M7
 * kickoff requires even if the owner's allowlist is misconfigured: "Sealed pools never touch the
 * inbox, in either direction. local-only and home scopes are never published."
 */

export interface PublishBriefsOutcome {
  published: number;
  skipped: number;
}

export async function runPublishBriefs(
  db: Database.Database,
  nodeId: string,
  humanClientId: string,
  allowlist: readonly string[],
  transport: BriefPublishTransport,
  flags: Map<string, boolean> | undefined,
): Promise<PublishBriefsOutcome> {
  const outcome: PublishBriefsOutcome = { published: 0, skipped: 0 };
  if (!isFlagOn(flags, "mobile_inbox.publish_briefs") || allowlist.length === 0) return outcome;

  const ctx: RequestContext = { db, clock: new HlcClock(nodeId), nodeId, clientId: humanClientId, clientName: "human", vendor: "human", assumedPools: [], flags };
  const briefs: InboxBrief[] = [];
  for (const scopeName of allowlist) {
    const scope = loadScopeExclusionRow(db, scopeName);
    if (!scope || exclusionReason(scope)) {
      outcome.skipped++;
      continue;
    }
    try {
      briefs.push({ scope: scopeName, payload: assembleBrief(ctx, { scope: scopeName, size: "micro" }) });
    } catch {
      outcome.skipped++;
    }
  }
  if (briefs.length > 0) {
    await transport.publishBriefs(briefs);
    outcome.published = briefs.length;
  }
  return outcome;
}
