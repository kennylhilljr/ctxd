import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxEntrySchema, type InboxEntry, type InboxPullPage, type InboxStatus, type InboxTransport } from "./types.js";

/**
 * Offline-development transport (MI-2, M7 kickoff section 2): one JSON file per entry under
 * `dir`, named `<inboxEntryId>.json` so `ack` can delete by id directly. A phone app cannot write
 * here; this is for `ctxd inbox pull` against a scratch directory while the cloud adapter (slice
 * 5) doesn't exist yet, or in tests that want a real filesystem instead of the fake transport.
 */
export class LocalDirInboxTransport implements InboxTransport {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Writes one entry file, as a phone app's own capture step would (test and dev helper, not part of the interface). */
  capture(entry: InboxEntry): void {
    writeFileSync(join(this.dir, `${entry.inboxEntryId}.json`), JSON.stringify(entry));
  }

  async pull(limit: number): Promise<InboxPullPage> {
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const page = files.slice(0, limit);
    const entries = page.map((f) => inboxEntrySchema.parse(JSON.parse(readFileSync(join(this.dir, f), "utf8"))));
    return { entries, more: files.length > limit };
  }

  async ack(inboxEntryIds: readonly string[]): Promise<void> {
    for (const id of inboxEntryIds) rmSync(join(this.dir, `${id}.json`), { force: true });
  }

  async status(): Promise<InboxStatus> {
    return { pending: readdirSync(this.dir).filter((f) => f.endsWith(".json")).length };
  }
}
