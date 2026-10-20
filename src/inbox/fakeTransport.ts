import type { InboxBrief, InboxEntry, InboxPullPage, InboxStatus, InboxTransport, BriefPublishTransport } from "./types.js";

/**
 * In-memory `InboxTransport` for tests (MI-2). `failAckOnce` simulates the hub crashing after a
 * page's entries were applied but before the transport recorded the ack (slice 4's crash-recovery
 * property): the entries stay in the buffer, so the next `pull` re-delivers them.
 */
export class FakeInboxTransport implements InboxTransport, BriefPublishTransport {
  private entries: InboxEntry[];
  private failAckOnce: boolean;
  readonly publishedBriefs: InboxBrief[] = [];

  constructor(entries: readonly InboxEntry[] = [], opts: { failAckOnce?: boolean } = {}) {
    this.entries = [...entries];
    this.failAckOnce = opts.failAckOnce ?? false;
  }

  seed(entries: readonly InboxEntry[]): void {
    this.entries.push(...entries);
  }

  async pull(limit: number): Promise<InboxPullPage> {
    const page = this.entries.slice(0, limit);
    return { entries: page, more: this.entries.length > limit };
  }

  async ack(inboxEntryIds: readonly string[]): Promise<void> {
    if (this.failAckOnce) {
      this.failAckOnce = false;
      throw new Error("simulated crash before ack");
    }
    const ids = new Set(inboxEntryIds);
    this.entries = this.entries.filter((e) => !ids.has(e.inboxEntryId));
  }

  async status(): Promise<InboxStatus> {
    return { pending: this.entries.length };
  }

  async publishBriefs(briefs: readonly InboxBrief[]): Promise<void> {
    this.publishedBriefs.push(...briefs);
  }
}
