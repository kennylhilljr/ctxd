import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { encodeHlc, HlcClock } from "../../src/core/hlc.js";
import { makeRev, newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { handleClaim, type ClaimInput } from "../../src/store/claim.js";
import { rebuild } from "../../src/store/rebuild.js";
import { type WriteContext } from "../../src/store/write.js";
import { applyEvent, type WireEvent } from "../../src/sync/apply.js";

/** Tests for Spec v8 7.4's claims-across-nodes policies, via sync's applyEvent: concurrent claims on one task, stale releases, overlap detection, and (via handleClaim directly) the tentative flag. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-sync-claims-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  nodeId: string;
  scopeId: string;
  agentAId: string;
  agentBId: string;
  humanId: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(scopeId, now());
  const agentAId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-a', 'openai', ?, ?, ?)").run(agentAId, nodeId, newId(), now());
  const agentBId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-b', 'openai', ?, ?, ?)").run(agentBId, nodeId, newId(), now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now());
  return { db, nodeId, scopeId, agentAId, agentBId, humanId };
}

function hlcAt(physical: number, node: string): string {
  return encodeHlc({ physical, counter: 0, node });
}

/** A synthetic "claim" WireEvent, as if it arrived from a remote node. `parentRevs` defaults to `[]` (a fresh claim); pass the prior claim_hlc for a renewal or take-over. */
function claimWireEvent(
  f: Fixture,
  args: { entryId: string; holder: string; hlc: string; paths?: string[] | null; takenOverFrom?: string | null; parentRevs?: string[] },
): WireEvent {
  const eventId = newId();
  return {
    eventId,
    originNode: newId(),
    originSeq: 1,
    hlc: args.hlc,
    scopeId: f.scopeId,
    entryId: args.entryId,
    op: "claim",
    part: "claim",
    parentRevs: args.parentRevs ?? [],
    rev: makeRev(1, eventId),
    clientId: args.holder,
    sessionRef: null,
    requestId: null,
    requestHash: null,
    payload: {
      holder: args.holder,
      paths: args.paths ?? null,
      ttl_minutes: 120,
      session_ref: null,
      base_head: null,
      taken_over_from: args.takenOverFrom ?? null,
      tentative: false,
    },
    prev: null,
  };
}

/** A synthetic "release" WireEvent referencing the claim_hlc it targets (Spec 7.4). */
function releaseWireEvent(f: Fixture, args: { entryId: string; holder: string; hlc: string; claimHlc: string }): WireEvent {
  const eventId = newId();
  return {
    eventId,
    originNode: newId(),
    originSeq: 1,
    hlc: args.hlc,
    scopeId: f.scopeId,
    entryId: args.entryId,
    op: "release",
    part: "claim",
    parentRevs: [args.claimHlc],
    rev: makeRev(1, eventId),
    clientId: args.holder,
    sessionRef: null,
    requestId: null,
    requestHash: null,
    payload: { changed_files: null, drift: null },
    prev: null,
  };
}

interface LeaseRow {
  task_id: string;
  holder: string;
  state: string;
  claim_hlc: string;
}

function readLease(db: Database.Database, taskId: string): LeaseRow {
  return db.prepare("SELECT task_id, holder, state, claim_hlc FROM leases WHERE task_id = ?").get(taskId) as LeaseRow;
}

describe("concurrent claims on one task (Spec 7.4)", () => {
  it("the earlier claim_hlc wins regardless of application order, and the loser is recorded as a lost sibling", () => {
    function run(order: "a-then-b" | "b-then-a"): { holderIsA: boolean; state: string; claimHlc: string; lostReasons: string[] } {
      const f = setup();
      const taskId = newId();
      const a = claimWireEvent(f, { entryId: taskId, holder: f.agentAId, hlc: hlcAt(1000, "shared-node") });
      const b = claimWireEvent(f, { entryId: taskId, holder: f.agentBId, hlc: hlcAt(2000, "shared-node") });
      if (order === "a-then-b") {
        applyEvent(f.db, a);
        applyEvent(f.db, b);
      } else {
        applyEvent(f.db, b);
        applyEvent(f.db, a);
      }
      const lease = readLease(f.db, taskId);
      const lostReasons = (f.db.prepare("SELECT reason FROM entry_siblings WHERE entry_id = ? AND part = 'claim'").all(taskId) as { reason: string }[]).map(
        (r) => r.reason,
      );
      return { holderIsA: lease.holder === f.agentAId, state: lease.state, claimHlc: lease.claim_hlc, lostReasons };
    }

    const forward = run("a-then-b");
    const backward = run("b-then-a");
    expect(forward).toEqual(backward);
    expect(forward.holderIsA).toBe(true); // a's claim_hlc (1000) is earlier than b's (2000)
    expect(forward.state).toBe("active");
    expect(forward.claimHlc).toBe(hlcAt(1000, "shared-node"));
    expect(forward.lostReasons).toEqual(["lost"]); // b's claim is the only one recorded as lost
  });

  it("a take-over of an expired lease is not treated as a concurrent-claim race, even though it arrives with a later HLC", () => {
    const f = setup();
    const taskId = newId();
    const original = claimWireEvent(f, { entryId: taskId, holder: f.agentAId, hlc: hlcAt(1000, f.nodeId) });
    expect(applyEvent(f.db, original).outcome).toBe("fast-forward");

    const takeover = claimWireEvent(f, {
      entryId: taskId,
      holder: f.agentBId,
      hlc: hlcAt(2000, f.nodeId),
      takenOverFrom: f.agentAId,
      parentRevs: [hlcAt(1000, f.nodeId)],
    });
    expect(applyEvent(f.db, takeover).outcome).toBe("fast-forward");

    const lease = readLease(f.db, taskId);
    expect(lease.holder).toBe(f.agentBId);
    expect(lease.state).toBe("active");
    expect(lease.claim_hlc).toBe(hlcAt(2000, f.nodeId));
  });
});

describe("a release only applies to the claim it was issued against (Spec 7.4)", () => {
  it("a stale release for a claim already superseded by a take-over is a no-op", () => {
    const f = setup();
    const taskId = newId();
    const original = claimWireEvent(f, { entryId: taskId, holder: f.agentAId, hlc: hlcAt(1000, f.nodeId) });
    applyEvent(f.db, original);
    const takeover = claimWireEvent(f, {
      entryId: taskId,
      holder: f.agentBId,
      hlc: hlcAt(2000, f.nodeId),
      takenOverFrom: f.agentAId,
      parentRevs: [hlcAt(1000, f.nodeId)],
    });
    applyEvent(f.db, takeover);

    const staleRelease = releaseWireEvent(f, { entryId: taskId, holder: f.agentAId, hlc: hlcAt(1500, f.nodeId), claimHlc: hlcAt(1000, f.nodeId) });
    // Routed through the conflict-checking path, same as a genuine race, even though
    // materialize.ts's handler finds nothing to resolve (the release's target claim has already
    // been superseded, so it is a no-op there): src/sync/apply.ts's `decide` tells "target never
    // arrived" from "target arrived and was superseded" by whether a claim was ever recorded at
    // that exact hlc (`claimHlcEverRecorded`), and this node's own earlier claim event proves it.
    expect(applyEvent(f.db, staleRelease).outcome).toBe("conflict-resolved");

    const lease = readLease(f.db, taskId);
    expect(lease.state).toBe("active"); // unchanged: the release targeted the superseded claim, not the current one
    expect(lease.holder).toBe(f.agentBId);
  });

  it("a release matching the current claim releases it", () => {
    const f = setup();
    const taskId = newId();
    const claim = claimWireEvent(f, { entryId: taskId, holder: f.agentAId, hlc: hlcAt(1000, f.nodeId) });
    applyEvent(f.db, claim);

    const release = releaseWireEvent(f, { entryId: taskId, holder: f.agentAId, hlc: hlcAt(1500, f.nodeId), claimHlc: hlcAt(1000, f.nodeId) });
    expect(applyEvent(f.db, release).outcome).toBe("fast-forward");
    expect(readLease(f.db, taskId).state).toBe("released");
  });

  it("a duplicate release for an already-released claim (no active lease at all) is a no-op, not deferred forever", () => {
    const f = setup();
    const taskId = newId();
    applyEvent(f.db, claimWireEvent(f, { entryId: taskId, holder: f.agentAId, hlc: hlcAt(1000, f.nodeId) }));
    const firstRelease = releaseWireEvent(f, { entryId: taskId, holder: f.agentAId, hlc: hlcAt(1500, f.nodeId), claimHlc: hlcAt(1000, f.nodeId) });
    applyEvent(f.db, firstRelease);
    expect(readLease(f.db, taskId).state).toBe("released");

    // A second, distinct release event (different eventId, so not caught by "already-known")
    // for the exact same claim: two nodes mechanically releasing the same claim while
    // partitioned. `release` never changes `claim_hlc` (only `state`/`released_at`/...), so the
    // row's claim_hlc is still this same claim's hlc -- this duplicate's parentRevs matches it
    // directly, fast-forwarding through the idempotent release handler again rather than needing
    // any conflict check at all.
    const duplicateRelease = releaseWireEvent(f, { entryId: taskId, holder: f.agentAId, hlc: hlcAt(1600, f.nodeId), claimHlc: hlcAt(1000, f.nodeId) });
    expect(applyEvent(f.db, duplicateRelease).outcome).toBe("fast-forward");
    expect(readLease(f.db, taskId).state).toBe("released");
  });
});

describe("overlapping write intent across tasks, detected at sync (Spec 7.4, claim_overlaps origin 'sync')", () => {
  it("records a claim_overlaps row in both directions when a replicated claim's paths overlap an already-active claim", () => {
    const f = setup();
    const taskX = newId();
    const taskY = newId();
    applyEvent(f.db, claimWireEvent(f, { entryId: taskX, holder: f.agentAId, hlc: hlcAt(1000, f.nodeId), paths: ["src/**"] }));
    applyEvent(f.db, claimWireEvent(f, { entryId: taskY, holder: f.agentBId, hlc: hlcAt(2000, f.nodeId), paths: ["src/shared.ts"] }));

    const rows = f.db.prepare("SELECT task_id, other_task_id, origin, policy, patterns FROM claim_overlaps ORDER BY task_id").all() as {
      task_id: string;
      other_task_id: string;
      origin: string;
      policy: string;
      patterns: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.origin === "sync")).toBe(true);
    expect(rows.map((r) => [r.task_id, r.other_task_id]).sort()).toEqual(
      [
        [taskX, taskY],
        [taskY, taskX],
      ].sort(),
    );

    // Each row's own "mine" is that row's own task_id's pattern, not the other side's: taskX's
    // pattern is "src/**", taskY's is "src/shared.ts".
    const forX = rows.find((r) => r.task_id === taskX)!;
    const forY = rows.find((r) => r.task_id === taskY)!;
    expect(JSON.parse(forX.patterns)).toEqual([{ mine: "src/**", theirs: "src/shared.ts" }]);
    expect(JSON.parse(forY.patterns)).toEqual([{ mine: "src/shared.ts", theirs: "src/**" }]);
  });

  it("records nothing when write intent does not overlap", () => {
    const f = setup();
    const taskX = newId();
    const taskY = newId();
    applyEvent(f.db, claimWireEvent(f, { entryId: taskX, holder: f.agentAId, hlc: hlcAt(1000, f.nodeId), paths: ["src/a.ts"] }));
    applyEvent(f.db, claimWireEvent(f, { entryId: taskY, holder: f.agentBId, hlc: hlcAt(2000, f.nodeId), paths: ["src/b.ts"] }));

    expect(f.db.prepare("SELECT COUNT(*) AS n FROM claim_overlaps").get()).toEqual({ n: 0 });
  });

  it("a rebuild reproduces the same claim_overlaps rows a local claim already wrote (convergence, Spec 7.3)", () => {
    const f = setup();
    const ctx: WriteContext = { db: f.db, clock: new HlcClock(f.nodeId), nodeId: f.nodeId, clientId: f.humanId };
    handleClaim(ctx, { scope: "sample-app", action: "claim", title: "T1", paths: ["src/shared.ts"], ttl_minutes: 120, request_id: newId() });
    handleClaim(ctx, { scope: "sample-app", action: "claim", title: "T2", paths: ["src/shared.ts"], ttl_minutes: 120, request_id: newId() });

    const dump = (): string => JSON.stringify(f.db.prepare("SELECT * FROM claim_overlaps ORDER BY task_id, other_task_id").all());
    const before = dump();
    expect(JSON.parse(before)).toHaveLength(2); // both directions, origin 'claim'

    rebuild(f.db);
    expect(dump()).toBe(before);
  });
});

describe("tentative claims (Spec 7.4: 'no successful sync for 10 minutes')", () => {
  function claimCtx(f: Fixture): WriteContext {
    return { db: f.db, clock: new HlcClock(f.nodeId), nodeId: f.nodeId, clientId: f.humanId };
  }

  function claimInput(title: string): ClaimInput {
    return { scope: "sample-app", action: "claim", title, ttl_minutes: 120, request_id: newId() };
  }

  it("is never tentative when this node has no peers at all", () => {
    const f = setup();
    const result = handleClaim(claimCtx(f), claimInput("T1")) as { lease: { tentative: boolean } };
    expect(result.lease.tentative).toBe(false);
  });

  it("is tentative when a peer exists but none has ever synced successfully", () => {
    const f = setup();
    f.db
      .prepare("INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at) VALUES (?, 'laptop', 'https://laptop.example/ctxd-sync', 'home', ?, ?)")
      .run(newId(), newId(), now());
    const result = handleClaim(claimCtx(f), claimInput("T2")) as { lease: { tentative: boolean } };
    expect(result.lease.tentative).toBe(true);
  });

  it("is tentative when the last successful sync was more than 10 minutes ago", () => {
    const f = setup();
    const staleSync = new Date(Date.now() - 11 * 60_000).toISOString();
    f.db
      .prepare(
        "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at, last_synced_at) VALUES (?, 'laptop', 'https://laptop.example/ctxd-sync', 'home', ?, ?, ?)",
      )
      .run(newId(), newId(), now(), staleSync);
    const result = handleClaim(claimCtx(f), claimInput("T3")) as { lease: { tentative: boolean } };
    expect(result.lease.tentative).toBe(true);
  });

  it("is not tentative when a peer synced successfully within the last 10 minutes", () => {
    const f = setup();
    f.db
      .prepare(
        "INSERT INTO peers (peer_id, name, url, role, incoming_token_hash, created_at, last_synced_at) VALUES (?, 'laptop', 'https://laptop.example/ctxd-sync', 'home', ?, ?, ?)",
      )
      .run(newId(), newId(), now(), now());
    const result = handleClaim(claimCtx(f), claimInput("T4")) as { lease: { tentative: boolean } };
    expect(result.lease.tentative).toBe(false);
  });
});
