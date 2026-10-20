import type { InboxBrief, InboxPullPage, InboxStatus, InboxTransport, BriefPublishTransport } from "./types.js";

/**
 * The hub-side half of the Cloudflare adapter (MI-2; M7-plan-v1 section 2's recommendation):
 * outbound HTTPS only, to whatever Worker `endpoint` the owner deployed from cloud/mobile-inbox-
 * worker/ (slice 5's deployment artifacts). `hubToken` is a pull-and-ack-only credential, distinct
 * from the write-only tokens phone clients use to call the Worker's own `POST /v1/inbox/entries`;
 * it is read from the macOS Keychain by the caller (MI-10), never passed on the command line or
 * stored in this class. `fetchImpl` is injectable for tests, matching src/sync/pull.ts's
 * `pullFromPeer`.
 */
export class CloudflareInboxTransport implements InboxTransport, BriefPublishTransport {
  constructor(
    private readonly endpoint: string,
    private readonly hubToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): HeadersInit {
    return { authorization: `Bearer ${this.hubToken}`, "content-type": "application/json" };
  }

  async pull(limit: number): Promise<InboxPullPage> {
    const url = new URL("/v1/inbox/pull", this.endpoint);
    url.searchParams.set("limit", String(limit));
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`mobile inbox pull failed: HTTP ${res.status}`);
    return (await res.json()) as InboxPullPage;
  }

  async ack(inboxEntryIds: readonly string[]): Promise<void> {
    const res = await this.fetchImpl(new URL("/v1/inbox/ack", this.endpoint), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ids: inboxEntryIds }),
    });
    if (!res.ok) throw new Error(`mobile inbox ack failed: HTTP ${res.status}`);
  }

  async status(): Promise<InboxStatus> {
    const res = await this.fetchImpl(new URL("/v1/inbox/status", this.endpoint), { headers: this.headers() });
    if (!res.ok) throw new Error(`mobile inbox status failed: HTTP ${res.status}`);
    return (await res.json()) as InboxStatus;
  }

  /** MI-9, gated by mobile_inbox.publish_briefs at the call site (src/inbox/publishBriefs.ts). */
  async publishBriefs(briefs: readonly InboxBrief[]): Promise<void> {
    const res = await this.fetchImpl(new URL("/v1/inbox/briefs", this.endpoint), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ briefs }),
    });
    if (!res.ok) throw new Error(`mobile inbox brief publish failed: HTTP ${res.status}`);
  }
}
