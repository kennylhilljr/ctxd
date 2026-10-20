import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { FakeInboxTransport } from "../../src/inbox/fakeTransport.js";
import { runInboxPull } from "../../src/inbox/pull.js";

/**
 * Slice 4 (PRD-mobile-inbox-v1 MI-3, MI-4): at-least-once delivery, with duplicates and
 * reordering across separate pull calls (the transport re-delivering an id more than once, in any
 * order, across any number of batches), still materializes exactly one entry per distinct
 * `inboxEntryId` -- never zero, never more than one. `runInboxPull` is called repeatedly, as a
 * scheduled `ctxd inbox pull` would be, each time seeding a random, possibly-overlapping batch
 * onto the same transport first.
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
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ctxd-inbox-property-")), "ctxd.db"), { create: true });
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

function captureFor(id: string): unknown {
  return { scope: "sample-app", kind: "note", title: `capture ${id}`, body: `body for ${id}`, capturedAt: "2026-10-20T12:00:00.000Z" };
}

describe("inbox delivery property: duplicates and reordering never duplicate materialized state", () => {
  it("any sequence of batches, each a shuffled and possibly-repeating subset of a fixed id pool, ends with exactly one entry per distinct id once drained", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 7 }), { minLength: 1, maxLength: 5 }), // id pool (by index)
        fc.array(fc.array(fc.integer({ min: 0, max: 7 }), { minLength: 0, maxLength: 6 }), { minLength: 1, maxLength: 5 }), // delivery batches: each an array of indexes into the pool, possibly repeating or reordered
        async (idPool, batches) => {
          const f = setup();
          const transport = new FakeInboxTransport();
          const ids = idPool.map((n) => `evt-${n}`);
          const usedIds = new Set<string>(); // only ids actually seeded in some batch, not every id in the pool

          for (const batch of batches) {
            for (const idx of batch) {
              const id = ids[idx % ids.length];
              if (id) {
                transport.seed(id, captureFor(id));
                usedIds.add(id);
              }
            }
            await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON);
          }
          await runInboxPull(f.db, f.nodeId, f.clientId, transport, FLAGS_ON); // drain anything a prior page's `more` left behind

          const rows = f.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
          expect(rows.n).toBe(usedIds.size);
          expect(await transport.status()).toEqual({ pending: 0 });
        },
      ),
      { numRuns: 50 },
    );
  });
});
