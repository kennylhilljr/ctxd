import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { handleClaim, type ClaimInput } from "../../src/store/claim.js";
import { flagEntry } from "../../src/store/flag.js";
import { rebuild } from "../../src/store/rebuild.js";
import type { WriteContext } from "../../src/store/write.js";
import { CtxdError } from "../../src/core/errors.js";

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-claim-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  clock: HlcClock;
  nodeId: string;
  agentAId: string;
  agentBId: string;
  humanId: string;
}

function setup(intentPolicy: "observe" | "warn" | "strict" = "warn"): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  db.prepare("INSERT INTO scopes (scope_id, name, intent_policy, created_at) VALUES (?, 'sample-app', ?, ?)").run("scope-1", intentPolicy, now());

  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    humanId,
    nodeId,
    newId(),
    now(),
  );
  const agentAId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-a', 'openai', ?, ?, ?)").run(
    agentAId,
    nodeId,
    newId(),
    now(),
  );
  const agentBId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-b', 'openai', ?, ?, ?)").run(
    agentBId,
    nodeId,
    newId(),
    now(),
  );
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentAId}`);
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentBId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', 'scope-1', 'write')").run();
  return { db, clock: new HlcClock(nodeId), nodeId, agentAId, agentBId, humanId };
}

function wctx(f: Fixture, clientId: string, assumedPools: string[] = []): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId, assumedPools };
}

function claim(input: Partial<ClaimInput> & { scope: string; action: ClaimInput["action"] }): ClaimInput {
  return { ttl_minutes: 120, ...input };
}

function grantReadOnly(f: Fixture): void {
  f.db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-read', 'pool-read', ?)").run(now());
  f.db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-read', ?)").run(`client:${f.agentBId}`);
  f.db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-read', 'scope-1', 'read')").run();
}

describe("handleClaim (SPEC v6 section 7.5)", () => {
  it("creates a task and claims it when given a title", () => {
    const f = setup();
    const result = handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Wire context_claim", paths: ["src/store/claim.ts"] })) as {
      lease: { holder: string; state: string; paths: string[] | null };
      overlaps: unknown[];
    };
    expect(result.lease.holder).toBe("agent-a");
    expect(result.lease.state).toBe("active");
    expect(result.lease.paths).toEqual(["src/store/claim.ts"]);
    expect(result.overlaps).toEqual([]);
  });

  it("renews the same holder's active claim, extending expires_at", () => {
    const f = setup();
    const first = handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task", ttl_minutes: 15 })) as {
      lease: { task_id: string; expires_at: string };
    };
    const renewed = handleClaim(
      wctx(f, f.agentAId, ["pool-dev"]),
      claim({ scope: "sample-app", action: "claim", task_id: first.lease.task_id, ttl_minutes: 120 }),
    ) as { lease: { expires_at: string } };
    expect(Date.parse(renewed.lease.expires_at)).toBeGreaterThan(Date.parse(first.lease.expires_at));
  });

  it("refuses a second holder with CLAIM_HELD while the lease is active", () => {
    const f = setup();
    const first = handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task" })) as {
      lease: { task_id: string };
    };
    try {
      handleClaim(wctx(f, f.agentBId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", task_id: first.lease.task_id }));
      expect.fail("expected CLAIM_HELD");
    } catch (err) {
      expect(err).toBeInstanceOf(CtxdError);
      expect((err as CtxdError).code).toBe("CLAIM_HELD");
    }
  });

  it("returns CLAIM_STALE for an expired claim without take_over, and allows take_over to proceed", () => {
    const f = setup();
    const first = handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task", ttl_minutes: 15 })) as {
      lease: { task_id: string };
    };
    // Force the lease into the past directly, rather than a time-travel clock, since only expiry matters here.
    f.db.prepare("UPDATE leases SET expires_at = ? WHERE task_id = ?").run(new Date(Date.now() - 60_000).toISOString(), first.lease.task_id);

    try {
      handleClaim(wctx(f, f.agentBId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", task_id: first.lease.task_id }));
      expect.fail("expected CLAIM_STALE");
    } catch (err) {
      expect((err as CtxdError).code).toBe("CLAIM_STALE");
    }

    const takeover = handleClaim(
      wctx(f, f.agentBId, ["pool-dev"]),
      claim({ scope: "sample-app", action: "claim", task_id: first.lease.task_id, take_over: true }),
    ) as { lease: { holder: string; state: string } };
    expect(takeover.lease.holder).toBe("agent-b");
    expect(takeover.lease.state).toBe("active");
  });

  it("reports an overlap under the warn policy without refusing (default scope policy)", () => {
    const f = setup("warn");
    handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task A", paths: ["src/foo/*.ts"] }));
    const result = handleClaim(
      wctx(f, f.agentBId, ["pool-dev"]),
      claim({ scope: "sample-app", action: "claim", title: "Task B", paths: ["src/foo/bar.ts"] }),
    ) as { lease: { state: string }; overlaps: { holder: string }[] };
    expect(result.lease.state).toBe("active");
    expect(result.overlaps).toHaveLength(1);
    expect(result.overlaps[0]!.holder).toBe("agent-a");
  });

  it("refuses an overlapping claim under the strict policy, writing nothing", () => {
    const f = setup("strict");
    handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task A", paths: ["src/foo/*.ts"] }));
    try {
      handleClaim(wctx(f, f.agentBId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task B", paths: ["src/foo/bar.ts"] }));
      expect.fail("expected CLAIM_OVERLAP");
    } catch (err) {
      expect((err as CtxdError).code).toBe("CLAIM_OVERLAP");
    }
    const count = (f.db.prepare("SELECT COUNT(*) AS n FROM leases WHERE holder != ?").get(f.agentAId) as { n: number }).n;
    expect(count).toBe(0);
  });

  it("reports distinct literal paths as never overlapping, even under strict", () => {
    const f = setup("strict");
    handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task A", paths: ["src/a.ts"] }));
    const result = handleClaim(
      wctx(f, f.agentBId, ["pool-dev"]),
      claim({ scope: "sample-app", action: "claim", title: "Task B", paths: ["src/b.ts"] }),
    ) as { lease: { state: string }; overlaps: unknown[] };
    expect(result.lease.state).toBe("active");
    expect(result.overlaps).toEqual([]);
  });

  it("marks another active lease with unknown intent as intent_unknown, not an overlap", () => {
    const f = setup("warn");
    handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task A" })); // no paths: unknown intent
    const result = handleClaim(
      wctx(f, f.agentBId, ["pool-dev"]),
      claim({ scope: "sample-app", action: "claim", title: "Task B", paths: ["src/b.ts"] }),
    ) as { overlaps: unknown[]; intent_unknown: string[] };
    expect(result.overlaps).toEqual([]);
    expect(result.intent_unknown).toHaveLength(1);
  });

  it("releases a claim, computing drift against agent-supplied changed_files", () => {
    const f = setup();
    const claimed = handleClaim(
      wctx(f, f.agentAId, ["pool-dev"]),
      claim({ scope: "sample-app", action: "claim", title: "Task", paths: ["src/a.ts"] }),
    ) as { lease: { task_id: string } };

    const released = handleClaim(
      wctx(f, f.agentAId, ["pool-dev"]),
      claim({ scope: "sample-app", action: "release", task_id: claimed.lease.task_id, changed_files: ["src/a.ts", "src/b.ts"] }),
    ) as { lease: { state: string }; changed_files: string[]; drift: string[] };
    expect(released.lease.state).toBe("released");
    expect(released.changed_files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(released.drift).toEqual(["src/b.ts"]);
  });

  it("records null changed_files and drift when the agent doesn't supply changed_files (no hooks in M1)", () => {
    const f = setup();
    const claimed = handleClaim(
      wctx(f, f.agentAId, ["pool-dev"]),
      claim({ scope: "sample-app", action: "claim", title: "Task", paths: ["src/a.ts"] }),
    ) as { lease: { task_id: string } };
    const released = handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "release", task_id: claimed.lease.task_id })) as {
      changed_files: string[] | null;
      drift: string[] | null;
    };
    expect(released.changed_files).toBeNull();
    expect(released.drift).toBeNull();
  });

  it("refuses to release another holder's claim unless the caller is human", () => {
    const f = setup();
    const claimed = handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task" })) as {
      lease: { task_id: string };
    };
    expect(() => handleClaim(wctx(f, f.agentBId, ["pool-dev"]), claim({ scope: "sample-app", action: "release", task_id: claimed.lease.task_id }))).toThrow(
      CtxdError,
    );
    const released = handleClaim(wctx(f, f.humanId), claim({ scope: "sample-app", action: "release", task_id: claimed.lease.task_id })) as {
      lease: { state: string };
    };
    expect(released.lease.state).toBe("released");
  });

  it("lists leases in a scope, including for a client that only assumed read", () => {
    const f = setup();
    grantReadOnly(f);
    handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "claim", title: "Task A" }));
    const result = handleClaim(wctx(f, f.agentBId, ["pool-read"]), claim({ scope: "sample-app", action: "list" })) as { leases: { holder: string }[] };
    expect(result.leases).toHaveLength(1);
    expect(result.leases[0]!.holder).toBe("agent-a");
  });

  it("rejects claim/release below propose access, but allows list at read", () => {
    const f = setup();
    grantReadOnly(f);
    expect(() => handleClaim(wctx(f, f.agentBId, ["pool-read"]), claim({ scope: "sample-app", action: "claim", title: "Task" }))).toThrow(CtxdError);
    const listed = handleClaim(wctx(f, f.agentBId, ["pool-read"]), claim({ scope: "sample-app", action: "list" })) as { leases: unknown[] };
    expect(listed.leases).toEqual([]);
  });
});

function dumpHash(db: Database.Database): string {
  const rows = (table: string, order: string) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all());
  const dump = [rows("entries", "entry_id"), rows("flags", "flag_id"), rows("leases", "task_id")].join("\u0000");
  return createHash("sha256").update(dump).digest("hex");
}

describe("ctxd rebuild replays flag and claim/release events (AGENTS.md: sync/apply changes need convergence tests)", () => {
  it("reproduces identical flags and leases from the event log", () => {
    const f = setup();
    const claimed = handleClaim(
      wctx(f, f.agentAId, ["pool-dev"]),
      claim({ scope: "sample-app", action: "claim", title: "Task", paths: ["src/a.ts"] }),
    ) as { lease: { task_id: string } };
    flagEntry(wctx(f, f.agentBId, ["pool-dev"]), { ref: `ctxd:sample-app/${claimed.lease.task_id}`, problem: "stale", reason: "x", request_id: newId() });
    flagEntry(wctx(f, f.agentBId, ["pool-dev"]), { ref: `ctxd:sample-app/${claimed.lease.task_id}`, problem: "wrong", reason: "y", request_id: newId() });
    handleClaim(wctx(f, f.agentAId, ["pool-dev"]), claim({ scope: "sample-app", action: "release", task_id: claimed.lease.task_id, changed_files: ["src/a.ts"] }));

    const before = dumpHash(f.db);
    rebuild(f.db);
    const after = dumpHash(f.db);
    expect(after).toBe(before);
  });
});
