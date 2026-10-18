import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { handleClaim } from "../../src/store/claim.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { addRule, buildReviewReport, listRules, removeRule, resolveEntry } from "../../src/store/review.js";
import { CtxdError } from "../../src/core/errors.js";

/** Tests for `ctxd review` (SPEC v6 13, 10.4, 7.4, 7.5.4): the review report, approvals and rules. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-review-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  clock: HlcClock;
  nodeId: string;
  humanId: string;
  agentAId: string;
  agentBId: string;
}

function setup(intentPolicy: "observe" | "warn" | "strict" = "warn"): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  db.prepare("INSERT INTO scopes (scope_id, name, intent_policy, created_at) VALUES ('scope-1', 'sample-app', ?, ?)").run(intentPolicy, now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now());
  const agentAId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-a', 'openai', ?, ?, ?)").run(agentAId, nodeId, newId(), now());
  const agentBId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-b', 'openai', ?, ?, ?)").run(agentBId, nodeId, newId(), now());
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentAId}`);
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentBId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', 'scope-1', 'write')").run();
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, agentAId, agentBId };
}

function wctx(f: Fixture, clientId: string, assumedPools: string[] = ["pool-dev"]): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId, assumedPools };
}

describe("buildReviewReport", () => {
  it("lists a proposed entry (agent-written decision, no auto-accept rule)", () => {
    const f = setup();
    writeEntry(wctx(f, f.agentAId), { scope: "sample-app", kind: "decision", title: "Use SQLite", body: "Because it's simple.", request_id: newId() } as never);

    const report = buildReviewReport(f.db);
    expect(report.proposed).toHaveLength(1);
    expect(report.proposed[0]!.kind).toBe("decision");
    expect(report.proposed[0]!.created_by).toBe("agent-a");
  });

  it("reports conflicted and auto_resolved as empty: both are M3 sync artifacts this single-node build never produces", () => {
    const f = setup();
    const report = buildReviewReport(f.db);
    expect(report.conflicted).toEqual([]);
    expect(report.auto_resolved).toEqual([]);
  });

  it("flags two entries sharing a kind+slug in one scope as a name clash", () => {
    const f = setup();
    writeEntry(wctx(f, f.agentAId), { scope: "sample-app", kind: "task", title: "Ship it", body: "Ship it", request_id: newId() } as never);
    writeEntry(wctx(f, f.agentAId), { scope: "sample-app", kind: "task", title: "Ship it", body: "Ship it again", request_id: newId() } as never);

    const report = buildReviewReport(f.db);
    expect(report.name_clashes).toHaveLength(1);
    expect(report.name_clashes[0]!.refs).toHaveLength(2);
  });

  it("flags two skills sharing a skill_name (not title alone) as a name clash", () => {
    const f = setup();
    const body = (desc: string) => `---\nname: my-skill\ndescription: ${desc}\n---\ndo the thing`;
    writeEntry(wctx(f, f.agentAId), { scope: "sample-app", kind: "skill", title: "my-skill", body: body("First version."), request_id: newId() } as never);
    writeEntry(wctx(f, f.agentAId), { scope: "sample-app", kind: "skill", title: "my-skill", body: body("Second version."), request_id: newId() } as never);

    const report = buildReviewReport(f.db);
    const clash = report.name_clashes.find((c) => c.kind === "skill");
    expect(clash?.name).toBe("my-skill");
    expect(clash?.refs).toHaveLength(2);
  });

  it("lists a release's drift under a strict intent policy, but not under warn", () => {
    for (const policy of ["strict", "warn"] as const) {
      const f = setup(policy);
      const claimed = handleClaim(wctx(f, f.agentAId), {
        scope: "sample-app",
        action: "claim",
        title: "Task",
        paths: ["src/a.ts"],
        ttl_minutes: 120,
      } as never) as { lease: { task_id: string } };
      handleClaim(wctx(f, f.agentAId), {
        scope: "sample-app",
        action: "release",
        task_id: claimed.lease.task_id,
        changed_files: ["src/a.ts", "src/b.ts"],
        ttl_minutes: 120,
      } as never);

      const report = buildReviewReport(f.db);
      if (policy === "strict") {
        expect(report.drift).toHaveLength(1);
        expect(report.drift[0]!.drift).toEqual(["src/b.ts"]);
      } else {
        expect(report.drift).toEqual([]);
      }
    }
  });

  it("lists a stale-claim takeover", () => {
    const f = setup();
    const first = handleClaim(wctx(f, f.agentAId), { scope: "sample-app", action: "claim", title: "Task", ttl_minutes: 15 } as never) as {
      lease: { task_id: string };
    };
    f.db.prepare("UPDATE leases SET expires_at = ? WHERE task_id = ?").run(new Date(Date.now() - 60_000).toISOString(), first.lease.task_id);
    handleClaim(wctx(f, f.agentBId), { scope: "sample-app", action: "claim", task_id: first.lease.task_id, take_over: true, ttl_minutes: 120 } as never);

    const report = buildReviewReport(f.db);
    expect(report.takeovers).toHaveLength(1);
    expect(report.takeovers[0]!.holder).toBe("agent-b");
    expect(report.takeovers[0]!.taken_over_from).toBe("agent-a");
  });

  it("summarizes recent rejections by client, scope and code", () => {
    const f = setup();
    f.db
      .prepare("INSERT INTO rejections (rejection_id, client_id, scope_id, entry_id, tool, code, detail, at) VALUES (?, ?, 'scope-1', NULL, 'context_write', 'REV_CONFLICT', NULL, ?)")
      .run(newId(), f.agentAId, now());
    f.db
      .prepare("INSERT INTO rejections (rejection_id, client_id, scope_id, entry_id, tool, code, detail, at) VALUES (?, ?, 'scope-1', NULL, 'context_write', 'REV_CONFLICT', NULL, ?)")
      .run(newId(), f.agentAId, now());

    const report = buildReviewReport(f.db);
    expect(report.rejections).toEqual([{ client: "agent-a", scope: "sample-app", code: "REV_CONFLICT", count: 2 }]);
  });

  it("excludes rejections older than the window", () => {
    const f = setup();
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    f.db
      .prepare("INSERT INTO rejections (rejection_id, client_id, scope_id, entry_id, tool, code, detail, at) VALUES (?, ?, 'scope-1', NULL, 'context_write', 'REV_CONFLICT', NULL, ?)")
      .run(newId(), f.agentAId, old);

    expect(buildReviewReport(f.db, 7).rejections).toEqual([]);
  });
});

describe("resolveEntry (ctxd review --approve, human only)", () => {
  it("moves a proposed entry to active", () => {
    const f = setup();
    const result = writeEntry(wctx(f, f.agentAId), { scope: "sample-app", kind: "decision", title: "D", body: "b", request_id: newId() } as never) as {
      ref: string;
    };
    const resolved = resolveEntry(wctx(f, f.humanId), result.ref);
    expect(resolved.status).toBe("active");
  });

  it("refuses a non-human client", () => {
    const f = setup();
    const result = writeEntry(wctx(f, f.agentAId), { scope: "sample-app", kind: "decision", title: "D", body: "b", request_id: newId() } as never) as {
      ref: string;
    };
    expect(() => resolveEntry(wctx(f, f.agentAId), result.ref)).toThrow(CtxdError);
  });

  it("refuses an entry that is not proposed or conflicted", () => {
    const f = setup();
    const result = writeEntry(wctx(f, f.humanId), { scope: "sample-app", kind: "note", title: "N", body: "b", request_id: newId() } as never) as {
      ref: string;
    };
    expect(() => resolveEntry(wctx(f, f.humanId), result.ref)).toThrow(CtxdError);
  });
});

describe("review rules (SPEC v6 10.4, human only, narrow by construction)", () => {
  it("adds and lists a rule naming a client", () => {
    const f = setup();
    addRule(wctx(f, f.humanId), "sample-app", { kind: "convention", client: "agent-a", action: "auto-accept" });
    expect(listRules(f.db, "sample-app")).toEqual([{ kind: "convention", client: "agent-a", action: "auto-accept" }]);
  });

  it("rejects a rule naming neither a client nor confirmed_by_user", () => {
    const f = setup();
    expect(() => addRule(wctx(f, f.humanId), "sample-app", { kind: "decision", action: "auto-accept" })).toThrow(CtxdError);
  });

  it("rejects a rule for kind skill or preference", () => {
    const f = setup();
    expect(() => addRule(wctx(f, f.humanId), "sample-app", { kind: "skill", client: "agent-a", action: "auto-accept" })).toThrow(CtxdError);
    expect(() => addRule(wctx(f, f.humanId), "sample-app", { kind: "preference", client: "agent-a", action: "auto-accept" })).toThrow(CtxdError);
  });

  it("refuses a non-human client", () => {
    const f = setup();
    expect(() => addRule(wctx(f, f.agentAId), "sample-app", { kind: "convention", client: "agent-a", action: "auto-accept" })).toThrow(CtxdError);
  });

  it("removes a rule by index", () => {
    const f = setup();
    addRule(wctx(f, f.humanId), "sample-app", { kind: "convention", client: "agent-a", action: "auto-accept" });
    addRule(wctx(f, f.humanId), "sample-app", { kind: "decision", confirmed_by_user: true, action: "auto-accept" });
    const rules = removeRule(wctx(f, f.humanId), "sample-app", 0);
    expect(rules).toEqual([{ kind: "decision", confirmed_by_user: true, action: "auto-accept" }]);
  });

  it("a rule actually takes effect on the next matching write", () => {
    const f = setup();
    addRule(wctx(f, f.humanId), "sample-app", { kind: "decision", client: "agent-a", action: "auto-accept" });
    const result = writeEntry(wctx(f, f.agentAId), { scope: "sample-app", kind: "decision", title: "D", body: "b", request_id: newId() } as never) as {
      status: string;
    };
    expect(result.status).toBe("active");
    expect(buildReviewReport(f.db).proposed).toEqual([]);
  });

  it("review.remembered_rules off (PRD-feature-flags-v1): a matching rule is ignored and the write stays proposed", () => {
    const f = setup();
    addRule(wctx(f, f.humanId), "sample-app", { kind: "decision", client: "agent-a", action: "auto-accept" });
    const ctx: WriteContext = { ...wctx(f, f.agentAId), flags: new Map([["review.remembered_rules", false]]) };
    const result = writeEntry(ctx, { scope: "sample-app", kind: "decision", title: "D", body: "b", request_id: newId() } as never) as {
      status: string;
    };
    expect(result.status).toBe("proposed");
    expect(buildReviewReport(f.db).proposed).toHaveLength(1);
  });
});
