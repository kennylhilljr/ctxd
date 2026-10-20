import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { FakeInboxTransport } from "../../src/inbox/fakeTransport.js";
import { runInboxPull } from "../../src/inbox/pull.js";

/**
 * Slice 4 (PRD-mobile-inbox-v1 MI-4): if the hub halts after an entry's write transaction
 * committed but before the transport recorded the ack, the entry is still in the buffer next
 * time, and the retry must not create a second entry: `writeEntry`'s own idempotency (keyed on
 * the transport's id, src/inbox/pull.ts's `requestIdFor`) makes the replay a no-op.
 */

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
  clientId: string;
}

function setup(): Fixture {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ctxd-inbox-crash-")), "ctxd.db"), { create: true });
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(scopeId, now());
  const clientId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'mobile-inbox', 'other', ?, ?, ?)").run(
    clientId,
    nodeId,
    newId(),
    now(),
  );
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${clientId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'propose')").run(scopeId);
  return { db, nodeId, clientId };
}

const FLAGS_ON = new Map([["mobile_inbox", true]]);

function capture(): unknown {
  return { scope: "sample-app", kind: "note", title: "Call back the dentist", body: "Reminder from the mobile app.", capturedAt: "2026-10-20T12:00:00.000Z" };
}

describe("inbox crash recovery", () => {
  it("an ack that fails right after a successful apply does not lose the apply, and the retry does not duplicate it", async () => {
    const f = setup();
    const transport = new FakeInboxTransport([], { failAckOnce: true });
    transport.seed("evt-1", capture());

    // First pull: the write commits (applied), but ack throws right after -- standing in for the
    // real crash scenario, where the process dies in that same gap and `runInboxPull` never
    // returns at all. Either way, nothing acked the entry.
    await expect(runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON)).rejects.toThrow("simulated crash before ack");
    expect(await transport.status()).toEqual({ pending: 1 }); // never acked; still "in the buffer" on the real transport

    const afterCrash = f.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
    expect(afterCrash.n).toBe(1); // the write really did commit before the simulated crash

    // Resume: the same entry is re-delivered (at-least-once) and re-applied; writeEntry's own
    // idempotency (same client + request_id) makes this a replay, not a second entry.
    const second = await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);
    expect(second.applied).toBe(1);
    expect(await transport.status()).toEqual({ pending: 0 }); // this time the ack succeeds

    const afterResume = f.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
    expect(afterResume.n).toBe(1); // still exactly one entry
  });

  it("errored outcomes are not acked, so a genuine unexpected failure is retried rather than silently dropped", async () => {
    const f = setup();
    const transport = new FakeInboxTransport();
    transport.seed("evt-1", capture());
    // Revoking the mobile-inbox client between seeding and pulling makes writeEntry's own
    // loadClient lookup (src/store/snapshot.ts) return null and throw CtxdError("UNAUTHORIZED"),
    // which the pull loop treats as "errored" (an operational fault on this node), not "rejected"
    // (a verdict about the entry's own content).
    f.db.prepare("UPDATE clients SET revoked_at = ? WHERE client_id = ?").run(now(), f.clientId);

    const outcome = await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);
    expect(outcome).toEqual({ fetched: 1, applied: 0, held: 0, rejected: 0, errored: 1 });
    expect(await transport.status()).toEqual({ pending: 1 }); // left for the next pull once the client is unrevoked
  });
});
