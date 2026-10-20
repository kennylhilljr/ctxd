import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxPullPage, InboxStatus, InboxTransport } from "./types.js";

/**
 * Offline-development transport (MI-2, M7 kickoff section 2): one JSON file per entry under
 * `dir`, named `<inboxEntryId>.json`, where the filename (not anything inside the file) is the
 * entry's id: `ack` deletes by that filename, and a malformed or tampered file's own content
 * can never claim a different identity. A phone app cannot write here; this is for `ctxd inbox
 * pull` against a scratch directory while the cloud adapter (slice 5) doesn't exist yet, or in
 * tests that want a real filesystem instead of the fake transport.
 */
export class LocalDirInboxTransport implements InboxTransport {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Writes one entry file, as a phone app's own capture step would (test and dev helper, not part of the interface). `raw` is whatever content shape the caller wants to test against (valid or not). */
  capture(inboxEntryId: string, raw: unknown): void {
    writeFileSync(join(this.dir, `${inboxEntryId}.json`), JSON.stringify(raw));
  }

  async pull(limit: number): Promise<InboxPullPage> {
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const page = files.slice(0, limit);
    const entries = page.map((f) => ({ inboxEntryId: f.slice(0, -".json".length), raw: JSON.parse(readFileSync(join(this.dir, f), "utf8")) as unknown }));
    return { entries, more: files.length > limit };
  }

  async ack(inboxEntryIds: readonly string[]): Promise<void> {
    for (const id of inboxEntryIds) rmSync(join(this.dir, `${id}.json`), { force: true });
  }

  async status(): Promise<InboxStatus> {
    return { pending: readdirSync(this.dir).filter((f) => f.endsWith(".json")).length };
  }
}
