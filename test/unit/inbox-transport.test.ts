import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeInboxTransport } from "../../src/inbox/fakeTransport.js";
import { LocalDirInboxTransport } from "../../src/inbox/localDirTransport.js";

/** Slice 2: both transports implement the same `InboxTransport` contract (MI-1, MI-2). */

function content(): unknown {
  return { scope: "sample-app", kind: "note", title: "t", body: "b", capturedAt: "2026-10-20T00:00:00.000Z" };
}

describe("FakeInboxTransport", () => {
  it("paginates, acks by id, and reports pending count", async () => {
    const t = new FakeInboxTransport();
    t.seed("a", content());
    t.seed("b", content());
    t.seed("c", content());
    expect(await t.status()).toEqual({ pending: 3 });

    const page = await t.pull(2);
    expect(page.entries.map((e) => e.inboxEntryId)).toEqual(["a", "b"]);
    expect(page.more).toBe(true);

    await t.ack(["a"]);
    expect(await t.status()).toEqual({ pending: 2 });
  });

  it("failAckOnce throws once, leaving entries in the buffer for the next pull", async () => {
    const t = new FakeInboxTransport([{ inboxEntryId: "a", raw: content() }], { failAckOnce: true });
    await t.pull(10);
    await expect(t.ack(["a"])).rejects.toThrow("simulated crash before ack");
    expect(await t.status()).toEqual({ pending: 1 }); // the failed ack never removed it

    await t.ack(["a"]); // second attempt succeeds (failAckOnce only fires once)
    expect(await t.status()).toEqual({ pending: 0 });
  });
});

describe("LocalDirInboxTransport", () => {
  it("captures to one file per entry, pulls them back, and acks by deleting the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxd-inbox-localdir-"));
    const t = new LocalDirInboxTransport(dir);
    t.capture("a", content());
    t.capture("b", content());

    expect(await t.status()).toEqual({ pending: 2 });
    const page = await t.pull(10);
    expect(page.entries.map((e) => e.inboxEntryId).sort()).toEqual(["a", "b"]);
    expect(page.more).toBe(false);

    await t.ack(["a"]);
    expect(await t.status()).toEqual({ pending: 1 });
  });

  it("pagination reports more when the directory holds more than the limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxd-inbox-localdir-"));
    const t = new LocalDirInboxTransport(dir);
    t.capture("a", content());
    t.capture("b", content());
    t.capture("c", content());

    const page = await t.pull(2);
    expect(page.entries).toHaveLength(2);
    expect(page.more).toBe(true);
  });

  it("the filename, not the file's own content, is the entry's id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxd-inbox-localdir-"));
    const t = new LocalDirInboxTransport(dir);
    t.capture("real-id", { ...(content() as Record<string, unknown>), inboxEntryId: "spoofed-id" });

    const page = await t.pull(10);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.inboxEntryId).toBe("real-id");
  });
});
