import { describe, expect, it } from "vitest";
import { CloudflareInboxTransport } from "../../src/inbox/cloudflareTransport.js";

/** Slice 5: the Cloudflare adapter's hub-side half, against a stubbed fetch (no real network or Worker). */

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(input instanceof Request ? input.url : input), init)) as typeof fetch;
}

describe("CloudflareInboxTransport", () => {
  it("pull sends the bearer token and limit, and parses the page", async () => {
    let seenAuth: string | null = null;
    let seenLimit: string | null = null;
    const transport = new CloudflareInboxTransport(
      "https://inbox.example.workers.dev",
      "hub-token-1",
      fakeFetch((url, init) => {
        seenAuth = (init?.headers as Record<string, string>).authorization;
        seenLimit = url.searchParams.get("limit");
        return new Response(JSON.stringify({ entries: [{ inboxEntryId: "42", raw: { scope: "sample-app" } }], more: false }), { status: 200 });
      }),
    );

    const page = await transport.pull(10);
    expect(seenAuth).toBe("Bearer hub-token-1");
    expect(seenLimit).toBe("10");
    expect(page.entries).toEqual([{ inboxEntryId: "42", raw: { scope: "sample-app" } }]);
    expect(page.more).toBe(false);
  });

  it("ack posts the ids and throws on a non-ok response", async () => {
    let seenBody: unknown;
    const transport = new CloudflareInboxTransport(
      "https://inbox.example.workers.dev",
      "hub-token-1",
      fakeFetch((_url, init) => {
        seenBody = JSON.parse(init?.body as string);
        return new Response(null, { status: 200 });
      }),
    );
    await transport.ack(["1", "2"]);
    expect(seenBody).toEqual({ ids: ["1", "2"] });

    const failing = new CloudflareInboxTransport("https://inbox.example.workers.dev", "hub-token-1", fakeFetch(() => new Response(null, { status: 401 })));
    await expect(failing.ack(["1"])).rejects.toThrow("HTTP 401");
  });

  it("status reports the pending count", async () => {
    const transport = new CloudflareInboxTransport(
      "https://inbox.example.workers.dev",
      "hub-token-1",
      fakeFetch(() => new Response(JSON.stringify({ pending: 7 }), { status: 200 })),
    );
    expect(await transport.status()).toEqual({ pending: 7 });
  });

  it("publishBriefs posts the briefs array", async () => {
    let seenBody: unknown;
    const transport = new CloudflareInboxTransport(
      "https://inbox.example.workers.dev",
      "hub-token-1",
      fakeFetch((_url, init) => {
        seenBody = JSON.parse(init?.body as string);
        return new Response(null, { status: 200 });
      }),
    );
    await transport.publishBriefs([{ scope: "sample-app", payload: { lines: ["hi"] } }]);
    expect(seenBody).toEqual({ briefs: [{ scope: "sample-app", payload: { lines: ["hi"] } }] });
  });
});
