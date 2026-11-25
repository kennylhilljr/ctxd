import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { encodeHlc, HlcClock } from "../../src/core/hlc.js";
import { deterministicId, makeRev, newId } from "../../src/core/ids.js";
import { SYSTEM_SCOPE_ID } from "../../src/core/kinds.js";
import { openDatabase } from "../../src/store/db.js";
import { rebuild } from "../../src/store/rebuild.js";
import { applyEvent, type WireEvent } from "../../src/sync/apply.js";
import { appendAclEvent } from "../../src/store/acl.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";

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

/** A synthetic replicated content create, as if it arrived from a remote node. */
function contentCreate(f: Fixture, scopeId: string, slug: string, extra: Record<string, unknown> = {}): WireEvent {
  const eventId = newId();
  return {
    eventId, originNode: newId(), originSeq: 1,
    hlc: encodeHlc({ physical: Date.now(), counter: defaultHlcCounter++, node: "test-node" }),
    scopeId, entryId: newId(), op: "create", part: "content", parentRevs: [], rev: makeRev(1, eventId),
    clientId: f.humanId, sessionRef: null, requestId: null, requestHash: null,
    payload: { kind: "note", slug, title: "Peer note", summary: "", body: "Body", tags: [], status: "active", ...extra },
    prev: null,
  };
}

describe("replicated names that would escape the Markdown mirror are rejected (issue 68)", () => {
  // FS-AC-6
  it("rejects a scope_create whose name contains a path separator, storing neither the scope nor the event", () => {
    const f = setup();
    const scopeId = deterministicId("scope", "../../escape");
    const event = aclWireEvent(f, scopeId, { action: "scope_create", name: "../../escape", kind: "project", replication: "all", vendor_policy: "any" });
    expect(() => applyEvent(f.db, event)).toThrow(/invalid scope name/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM scopes WHERE scope_id = ?").get(scopeId)).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = ?").get(event.eventId)).toEqual({ n: 0 });
  });

  // FS-AC-7
  it("rejects a replicated entry create whose slug contains ../, and accepts the same event with a valid slug", () => {
    const f = setup();
    const scopeId = deterministicId("scope", "sample-app");
    applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }));
    const create = (slug: string): WireEvent => {
      const eventId = newId();
      return {
        eventId, originNode: newId(), originSeq: 1,
        hlc: encodeHlc({ physical: Date.now(), counter: defaultHlcCounter++, node: "test-node" }),
        scopeId, entryId: newId(), op: "create", part: "content", parentRevs: [], rev: makeRev(1, eventId),
        clientId: f.humanId, sessionRef: null, requestId: null, requestHash: null,
        payload: { kind: "note", slug, title: "Peer note", summary: "", body: "Body", tags: [], status: "active" },
        prev: null,
      };
    };
    const bad = create("../../escaped");
    expect(() => applyEvent(f.db, bad)).toThrow(/invalid slug/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = ?").get(bad.eventId)).toEqual({ n: 0 });
    expect(() => applyEvent(f.db, create(`${"a".repeat(70)}-abc123`))).toThrow(/invalid slug/);
    expect(applyEvent(f.db, create("peer-note-abc123")).outcome).toBe("fast-forward");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 1 });
  });

  // FS-AC-8
  it("rejects a replicated skill create with a missing, traversing or over-64-character skill name", () => {
    const f = setup();
    const scopeId = deterministicId("scope", "sample-app");
    applyEvent(f.db, aclWireEvent(f, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" }));
    for (const skill_name of [null, "../../escape", "a".repeat(65)]) {
      expect(() => applyEvent(f.db, contentCreate(f, scopeId, "skill-note-abc123", { kind: "skill", skill_name }))).toThrow(/invalid skill name/);
    }
    expect(applyEvent(f.db, contentCreate(f, scopeId, "skill-note-abc123", { kind: "skill", skill_name: "sample-skill" })).outcome).toBe("fast-forward");
  });

  // FS-AC-7, FS-AC-8
  it("property: any mix of valid and invalid content and skill creates, applied in any order, materializes the same state of exactly the valid ones, and a rebuild agrees", () => {
    // [slug, extra payload, valid?]
    const cases: [string, Record<string, unknown>, boolean][] = [
      ["peer-note-aaa111", {}, true],
      ["peer-note-bbb222", {}, true],
      ["peer-skill-fff666", { kind: "skill", skill_name: "sample-skill" }, true],
      ["../../escaped", {}, false],
      ["a/b-ccc333", {}, false],
      ["Upper-ddd444", {}, false],
      [`${"a".repeat(70)}-eee555`, {}, false],
      ["peer-skill-ggg777", { kind: "skill", skill_name: null }, false],
      ["peer-skill-hhh888", { kind: "skill", skill_name: "../escape" }, false],
    ];
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: cases.length - 1 }), { minLength: 1, maxLength: cases.length }), fc.boolean(), (picks, reverse) => {
        const builder = setup();
        const scopeId = deterministicId("scope", "sample-app");
        const scopeEvent = aclWireEvent(builder, scopeId, { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" });
        const events = picks.map((i) => ({ event: contentCreate(builder, scopeId, cases[i]![0], cases[i]![1]), valid: cases[i]![2] }));
        const run = (order: typeof events) => {
          const f = setup();
          // Register the client that signed the shared events in this fresh database too.
          const nodeId = (f.db.prepare("SELECT node_id FROM nodes").get() as { node_id: string }).node_id;
          f.db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'peer-human', 'human', ?, ?, ?)").run(builder.humanId, nodeId, newId(), now());
          applyEvent(f.db, scopeEvent);
          for (const { event, valid } of order) {
            if (valid) expect(applyEvent(f.db, event).outcome).toBe("fast-forward");
            else expect(() => applyEvent(f.db, event)).toThrow(/invalid (slug|skill name)/);
          }
          return f.db;
        };
        const state = (db: Database.Database) =>
          db.prepare("SELECT entry_id, scope_id, kind, slug, skill_name, title, body, content_rev FROM entries ORDER BY entry_id").all();
        const a = run(events);
        const b = run(reverse ? [...events].reverse() : events);
        const expected = events.filter((e) => e.valid).map((e) => e.event.entryId).sort();
        expect((state(a) as { entry_id: string }[]).map((r) => r.entry_id)).toEqual(expected);
        expect(state(b)).toEqual(state(a));
        const before = state(a);
        rebuild(a);
        expect(state(a)).toEqual(before);
      }),
      { numRuns: 15 },
    );
  }, 60_000);

  // FS-AC-6
  it("rejects a scope_create whose name is path-safe but outside the scope grammar", () => {
    const f = setup();
    for (const name of ["Sample-App", "-private", "has space", "."]) {
      const event = aclWireEvent(f, deterministicId("scope", name), { action: "scope_create", name, kind: "project", replication: "all", vendor_policy: "any" });
      expect(() => applyEvent(f.db, event)).toThrow(/invalid scope name/);
    }
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM scopes WHERE kind = 'project'").get()).toEqual({ n: 0 });
  });

  // FS-AC-6
  it("property: any mix of valid and invalid scope_create events, in any order, converges on exactly the valid scopes, and a rebuild agrees", () => {
    const names = ["sample-app", "project-b", "notes", "../escape", "a/b", "Sample-App", "..", "x\\y"];
    const valid = new Set(["sample-app", "project-b", "notes"]);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: names.length - 1 }), { minLength: 1, maxLength: 10 }), fc.integer(), (picks, seed) => {
        const f = setup();
        const events = picks.map((i) => aclWireEvent(f, deterministicId("scope", names[i]!), {
          action: "scope_create", name: names[i]!, kind: "project", replication: "all", vendor_policy: "any",
        }));
        const order = [...events].sort((a, b) => ((a.eventId.charCodeAt(25) * 31 + seed) % 7) - ((b.eventId.charCodeAt(25) * 31 + seed) % 7));
        const g = setup();
        const applyAll = (db: Database.Database, list: WireEvent[]) => {
          for (const event of list) {
            try { applyEvent(db, event); } catch (err) { expect(String(err)).toMatch(/invalid scope name/); }
          }
        };
        applyAll(f.db, events);
        applyAll(g.db, order);
        const scopeNames = (db: Database.Database) =>
          (db.prepare("SELECT name FROM scopes WHERE kind = 'project' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
        const expected = [...new Set(picks.map((i) => names[i]!).filter((n) => valid.has(n)))].sort();
        expect(scopeNames(f.db)).toEqual(expected);
        expect(scopeNames(g.db)).toEqual(expected);
        rebuild(f.db);
        expect(scopeNames(f.db)).toEqual(expected);
      }),
      { numRuns: 15 },
    );
  }, 60_000);
});

describe("locally written names that would escape the Markdown mirror are rejected (issue 77)", () => {
  function local(f: Fixture): WriteContext {
    const nodeId = (f.db.prepare("SELECT node_id FROM nodes").get() as { node_id: string }).node_id;
    return { db: f.db, clock: new HlcClock(nodeId), nodeId, clientId: f.humanId, flags: new Map() };
  }

  // FS-AC-6: the local materialize path refuses the name even past the `ctxd scope add` check.
  it("rejects a locally appended scope_create with an invalid name, storing neither the scope nor the event", () => {
    const f = setup();
    for (const name of ["../escape", "Sample-App"]) {
      expect(() => appendAclEvent(local(f), deterministicId("scope", name), { action: "scope_create", name, kind: "project", replication: "all", vendor_policy: "any" }))
        .toThrow(/invalid scope name/);
    }
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM scopes WHERE kind = 'project'").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE op = 'acl'").get()).toEqual({ n: 0 });
  });

  // FS-AC-8
  it("rejects a local skill write whose name is missing, traversing or over 64 characters, storing no event", () => {
    const f = setup();
    appendAclEvent(local(f), deterministicId("scope", "sample-app"), { action: "scope_create", name: "sample-app", kind: "project", replication: "all", vendor_policy: "any" });
    const events = () => (f.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const before = events();
    for (const title of ["../escape", "a".repeat(65)]) {
      const body = `---\nname: ${title}\ndescription: A sample skill\n---\nSteps`;
      expect(() => writeEntry(local(f), { scope: "sample-app", kind: "skill", title, body, request_id: newId() } as never)).toThrow(/title must be the skill name/);
    }
    // Missing: no title, or a SKILL.md with no name in its frontmatter.
    expect(() => writeEntry(local(f), { scope: "sample-app", kind: "skill", title: "", body: "---\ndescription: A sample skill\n---\nSteps", request_id: newId() } as never)).toThrow();
    expect(() => writeEntry(local(f), { scope: "sample-app", kind: "skill", title: "sample-skill", body: "---\ndescription: A sample skill\n---\nSteps", request_id: newId() } as never)).toThrow(/frontmatter needs name/);
    expect(events()).toBe(before);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE kind = 'skill'").get()).toEqual({ n: 0 });
  });
});
