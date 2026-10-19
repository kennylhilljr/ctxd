import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { encodeHlc } from "../../src/core/hlc.js";
import { deterministicId, makeRev, newId } from "../../src/core/ids.js";
import { SYSTEM_SCOPE_ID } from "../../src/core/kinds.js";
import { openDatabase } from "../../src/store/db.js";
import { rebuild } from "../../src/store/rebuild.js";
import { applyEvent, type WireEvent } from "../../src/sync/apply.js";

/** Tests for Spec v8 4's acl events (M3 slice 6): scope/pool creation, grants and membership travel as events in the reserved _system scope, materialized via src/store/materialize.ts's applyAclEvent. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-sync-acl-")), "ctxd.db");
  return openDatabase(path, { create: true });
}

function now(): string {
  return new Date().toISOString();
}

interface Fixture {
  db: Database.Database;
  humanId: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  db.prepare(
    "INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, '_system', 'system', 'all', 'local-only', ?)",
  ).run(SYSTEM_SCOPE_ID, now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now());
  return { db, humanId };
}

function hlcAt(physical: number, node: string): string {
  return encodeHlc({ physical, counter: 0, node });
}

// A plain Date.now()-based default hlc, with a *different random node suffix per call* (as
// earlier versions of this helper did), does not reliably sort in call order: two events minted
// in the same millisecond tie on everything but that random suffix, and rebuild()'s `ORDER BY
// hlc` would then replay them in an arbitrary order instead of the order the test issued them in
// -- surfacing as a spurious FOREIGN KEY failure when a pool_grant replayed before its own
// pool_create. A shared counter on a fixed node keeps default-hlc calls strictly increasing.
let defaultHlcCounter = 0;

/** A synthetic "acl" WireEvent, as if it arrived from a remote node. */
function aclWireEvent(f: Fixture, entryId: string, payload: Record<string, unknown>, hlc?: string): WireEvent {
  const eventId = newId();
  return {
    eventId,
    originNode: newId(),
    originSeq: 1,
    hlc: hlc ?? encodeHlc({ physical: Date.now(), counter: defaultHlcCounter++, node: "test-node" }),
    scopeId: SYSTEM_SCOPE_ID,
    entryId,
    op: "acl",
    part: "meta",
    parentRevs: [],
    rev: makeRev(1, eventId),
    clientId: f.humanId,
    sessionRef: null,
    requestId: null,
    requestHash: null,
    payload,
    prev: null,
  };
}

describe("deterministic scope/pool ids (Spec v8 4)", () => {
  it("two nodes deriving an id from the same name always agree, without ever syncing", () => {
    expect(deterministicId("scope", "sample-app")).toBe(deterministicId("scope", "sample-app"));
    expect(deterministicId("pool", "pool-dev")).toBe(deterministicId("pool", "pool-dev"));
  });

  it("different names, or different namespaces for the same name, never collide", () => {
    expect(deterministicId("scope", "sample-app")).not.toBe(deterministicId("scope", "project-b"));
    expect(deterministicId("scope", "pool-dev")).not.toBe(deterministicId("pool", "pool-dev"));
  });
});

describe("scope_create (Spec v8 4)", () => {
  it("materializes a scope from a replicated acl event", () => {
    const f = setup();
    const scopeId = deterministicId("scope", "sample-app");
    const event = aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" });

    expect(applyEvent(f.db, event).outcome).toBe("fast-forward");
    const row = f.db.prepare("SELECT name, kind, replication, vendor_policy FROM scopes WHERE scope_id = ?").get(scopeId) as {
      name: string;
      kind: string;
      replication: string;
      vendor_policy: string;
    };
    expect(row).toEqual({ name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" });
  });

  it("two independent creates of the same name (same deterministic id, different declared fields) converge on the later HLC's fields, whichever order they apply in", () => {
    function run(order: "a-then-b" | "b-then-a"): string {
      const f = setup();
      const scopeId = deterministicId("scope", "sample-app");
      const a = aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }, hlcAt(1000, "shared-node"));
      const b = aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "home", vendor_policy: "local-only" }, hlcAt(2000, "shared-node"));
      if (order === "a-then-b") {
        applyEvent(f.db, a);
        applyEvent(f.db, b);
      } else {
        applyEvent(f.db, b);
        applyEvent(f.db, a);
      }
      return (f.db.prepare("SELECT replication FROM scopes WHERE scope_id = ?").get(scopeId) as { replication: string }).replication;
    }

    expect(run("a-then-b")).toBe("home");
    expect(run("b-then-a")).toBe("home");
  });
});

describe("pool_create, pool_grant, pool_revoke, pool_add_member, pool_remove_member (Spec v8 4)", () => {
  it("materializes a full pool lifecycle from replicated acl events", () => {
    const f = setup();
    const poolId = deterministicId("pool", "pool-dev");
    const scopeId = deterministicId("scope", "sample-app");
    applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }));
    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_create", name: "pool-dev", description: "dev pool" }));

    const pool = f.db.prepare("SELECT name, description FROM pools WHERE pool_id = ?").get(poolId) as { name: string; description: string };
    expect(pool).toEqual({ name: "pool-dev", description: "dev pool" });

    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_grant", scope_id: scopeId, level: "write" }));
    expect(f.db.prepare("SELECT level FROM pool_grants WHERE pool_id = ? AND scope_id = ?").get(poolId, scopeId)).toEqual({ level: "write" });

    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_add_member", principal: "tag:ci" }));
    expect(f.db.prepare("SELECT 1 FROM pool_members WHERE pool_id = ? AND principal = 'tag:ci'").get(poolId)).toBeDefined();

    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_revoke", scope_id: scopeId }));
    expect(f.db.prepare("SELECT 1 FROM pool_grants WHERE pool_id = ? AND scope_id = ?").get(poolId, scopeId)).toBeUndefined();

    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_remove_member", principal: "tag:ci" }));
    expect(f.db.prepare("SELECT 1 FROM pool_members WHERE pool_id = ? AND principal = 'tag:ci'").get(poolId)).toBeUndefined();
  });
});

describe("client_grant (Spec v8 4)", () => {
  it("materializes a temporary grant from a replicated acl event", () => {
    const f = setup();
    const scopeId = deterministicId("scope", "sample-app");
    applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }));

    const clientId = newId();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    applyEvent(f.db, aclWireEvent(f, clientId, { action: "client_grant", scope_id: scopeId, level: "read", expires_at: expiresAt, granted_by: f.humanId }));

    const row = f.db.prepare("SELECT level, expires_at, granted_by FROM client_grants WHERE client_id = ? AND scope_id = ?").get(clientId, scopeId) as {
      level: string;
      expires_at: string;
      granted_by: string;
    };
    expect(row).toEqual({ level: "read", expires_at: expiresAt, granted_by: f.humanId });
  });
});

describe("scope_review_policy_set (Spec v8 4, 10.4)", () => {
  it("replaces a scope's review policy from a replicated acl event", () => {
    const f = setup();
    const scopeId = deterministicId("scope", "sample-app");
    applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }));

    const rules = [{ kind: "convention", client: "claude-code@air", action: "auto-accept" }];
    applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_review_policy_set", review_policy: rules }));

    const row = f.db.prepare("SELECT review_policy FROM scopes WHERE scope_id = ?").get(scopeId) as { review_policy: string };
    expect(JSON.parse(row.review_policy)).toEqual(rules);
  });
});

describe("a rebuild reproduces the same acl-derived state (convergence, Spec 7.3)", () => {
  it("pools, grants and membership survive a rebuild identically", () => {
    const f = setup();
    const scopeId = deterministicId("scope", "sample-app");
    const poolId = deterministicId("pool", "pool-dev");
    applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }));
    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_create", name: "pool-dev", description: "" }));
    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_grant", scope_id: scopeId, level: "write" }));
    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_add_member", principal: "tag:ci" }));

    const dump = (): string =>
      JSON.stringify([
        f.db.prepare("SELECT * FROM pools ORDER BY pool_id").all(),
        f.db.prepare("SELECT * FROM pool_grants ORDER BY pool_id, scope_id").all(),
        f.db.prepare("SELECT * FROM pool_members ORDER BY pool_id, principal").all(),
      ]);
    const before = dump();
    rebuild(f.db);
    expect(dump()).toBe(before);
  });
});

// Found during /simplify: without an HLC guard, a grant and a revoke of the same pool+scope
// applied out of causal order would converge on whichever a given node happens to apply last,
// silently un-revoking access a later revoke already took away. These tests apply the pair in
// both orders and assert the SAME, later-HLC outcome either way (Spec 7.3's convergence property).
describe("concurrent grant/revoke, membership and review-policy changes converge by HLC, not arrival order (Spec 7.3, 7.4)", () => {
  it("pool_grants: a later revoke always wins over an earlier grant, whichever order they apply in", () => {
    function run(order: "grant-then-revoke" | "revoke-then-grant"): unknown {
      const f = setup();
      const scopeId = deterministicId("scope", "sample-app");
      const poolId = deterministicId("pool", "pool-dev");
      applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }));
      applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_create", name: "pool-dev", description: "" }));
      const grant = aclWireEvent(f, poolId, { action: "pool_grant", scope_id: scopeId, level: "write" }, hlcAt(1000, "shared-node"));
      const revoke = aclWireEvent(f, poolId, { action: "pool_revoke", scope_id: scopeId }, hlcAt(2000, "shared-node"));
      if (order === "grant-then-revoke") {
        applyEvent(f.db, grant);
        applyEvent(f.db, revoke);
      } else {
        applyEvent(f.db, revoke);
        applyEvent(f.db, grant);
      }
      return f.db.prepare("SELECT * FROM pool_grants WHERE pool_id = ? AND scope_id = ?").get(poolId, scopeId);
    }

    expect(run("grant-then-revoke")).toBeUndefined();
    expect(run("revoke-then-grant")).toBeUndefined(); // the stale grant never resurrects the revoked access
  });

  it("pool_members: a later remove always wins over an earlier add, whichever order they apply in", () => {
    function run(order: "add-then-remove" | "remove-then-add"): unknown {
      const f = setup();
      const poolId = deterministicId("pool", "pool-dev");
      applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_create", name: "pool-dev", description: "" }));
      const add = aclWireEvent(f, poolId, { action: "pool_add_member", principal: "tag:ci" }, hlcAt(1000, "shared-node"));
      const remove = aclWireEvent(f, poolId, { action: "pool_remove_member", principal: "tag:ci" }, hlcAt(2000, "shared-node"));
      if (order === "add-then-remove") {
        applyEvent(f.db, add);
        applyEvent(f.db, remove);
      } else {
        applyEvent(f.db, remove);
        applyEvent(f.db, add);
      }
      return f.db.prepare("SELECT 1 FROM pool_members WHERE pool_id = ? AND principal = 'tag:ci'").get(poolId);
    }

    expect(run("add-then-remove")).toBeUndefined();
    expect(run("remove-then-add")).toBeUndefined();
  });

  it("client_grants: the later of two conflicting grants always wins, whichever order they apply in", () => {
    function run(order: "a-then-b" | "b-then-a"): string {
      const f = setup();
      const scopeId = deterministicId("scope", "sample-app");
      const clientId = newId();
      applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }));
      const a = aclWireEvent(f, clientId, { action: "client_grant", scope_id: scopeId, level: "read", expires_at: "2030-01-01T00:00:00.000Z", granted_by: f.humanId }, hlcAt(1000, "shared-node"));
      const b = aclWireEvent(f, clientId, { action: "client_grant", scope_id: scopeId, level: "write", expires_at: "2031-01-01T00:00:00.000Z", granted_by: f.humanId }, hlcAt(2000, "shared-node"));
      if (order === "a-then-b") {
        applyEvent(f.db, a);
        applyEvent(f.db, b);
      } else {
        applyEvent(f.db, b);
        applyEvent(f.db, a);
      }
      return (f.db.prepare("SELECT level FROM client_grants WHERE client_id = ? AND scope_id = ?").get(clientId, scopeId) as { level: string }).level;
    }

    expect(run("a-then-b")).toBe("write");
    expect(run("b-then-a")).toBe("write");
  });

  it("scope_review_policy_set: the later of two conflicting policy changes always wins, whichever order they apply in", () => {
    function run(order: "a-then-b" | "b-then-a"): unknown {
      const f = setup();
      const scopeId = deterministicId("scope", "sample-app");
      applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }));
      const a = aclWireEvent(f, scopeId, { action: "scope_review_policy_set", review_policy: [{ kind: "convention", confirmed_by_user: true, action: "auto-accept" }] }, hlcAt(1000, "shared-node"));
      const b = aclWireEvent(f, scopeId, { action: "scope_review_policy_set", review_policy: [] }, hlcAt(2000, "shared-node"));
      if (order === "a-then-b") {
        applyEvent(f.db, a);
        applyEvent(f.db, b);
      } else {
        applyEvent(f.db, b);
        applyEvent(f.db, a);
      }
      return JSON.parse((f.db.prepare("SELECT review_policy FROM scopes WHERE scope_id = ?").get(scopeId) as { review_policy: string }).review_policy);
    }

    expect(run("a-then-b")).toEqual([]);
    expect(run("b-then-a")).toEqual([]);
  });

  it("an exact HLC tie on the same target accepts the second action instead of silently dropping it (found during /code-review)", () => {
    // An encoded HLC tie can only happen between two events from the same node (the node id is
    // part of the string); it was reachable in practice from two rapid, separate CLI invocations
    // whose HlcClock each started fresh at the same millisecond. Rejecting the tie used to drop
    // the second action silently while the CLI still printed success -- here, a remove tied with
    // the add that preceded it, which must still take effect.
    const f = setup();
    const poolId = deterministicId("pool", "pool-dev");
    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_create", name: "pool-dev", description: "" }));
    const tie = hlcAt(1000, "shared-node");
    applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_add_member", principal: "tag:ci" }, tie));
    expect(applyEvent(f.db, aclWireEvent(f, poolId, { action: "pool_remove_member", principal: "tag:ci" }, tie)).outcome).toBe("fast-forward");

    expect(f.db.prepare("SELECT 1 FROM pool_members WHERE pool_id = ? AND principal = 'tag:ci'").get(poolId)).toBeUndefined();
  });
});
