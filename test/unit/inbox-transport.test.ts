import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeInboxTransport } from "../../src/inbox/fakeTransport.js";
import { LocalDirInboxTransport } from "../../src/inbox/localDirTransport.js";
import type { InboxEntry } from "../../src/inbox/types.js";

/** Slice 2: both transports implement the same `InboxTransport` contract (MI-1, MI-2). */

function entry(id: string): InboxEntry {
  return { inboxEntryId: id, scope: "sample-app", kind: "note", title: "t", body: "b", capturedAt: "2026-10-20T00:00:00.000Z" };
}

describe("FakeInboxTransport", () => {
  it("paginates, acks by id, and reports pending count", async () => {
    const t = new FakeInboxTransport([entry("a"), entry("b"), entry("c")]);
    expect(await t.status()).toEqual({ pending: 3 });

    const page = await t.pull(2);
    expect(page.entries.map((e) => e.inboxEntryId)).toEqual(["a", "b"]);
    expect(page.more).toBe(true);

    await t.ack(["a"]);
    expect(await t.status()).toEqual({ pending: 2 });
  });

  it("failAckOnce throws once, leaving entries in the buffer for the next pull", async () => {
    const t = new FakeInboxTransport([entry("a")], { failAckOnce: true });
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
    t.capture(entry("a"));
    t.capture(entry("b"));

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
    t.capture(entry("a"));
    t.capture(entry("b"));
    t.capture(entry("c"));

    const page = await t.pull(2);
    expect(page.entries).toHaveLength(2);
    expect(page.more).toBe(true);
  });
});
