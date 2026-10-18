import { describe, expect, it } from "vitest";
import {
  accessLevel,
  decideWrite,
  visibleOrRestricted,
  poolsOf,
  workingSet,
  type AccessSnapshot,
  type ClientInfo,
  type ScopeInfo,
} from "../../src/access/level.js";

const scopes: Record<string, ScopeInfo> = {
  me: { id: "me", kind: "me", vendorPolicy: "any" },
  ctxd: { id: "ctxd", kind: "project", vendorPolicy: "any" },
  sharedTools: { id: "shared-tools", kind: "project", vendorPolicy: "any" },
  projectB: { id: "project-b", kind: "project", vendorPolicy: "any" },
  notes: { id: "notes", kind: "project", vendorPolicy: "any" },
  privateA: { id: "private-a", kind: "project", vendorPolicy: "any" },
  meNotes: { id: "meNotes", kind: "profile", owner: "pool-notes", vendorPolicy: "any" },
  meDev: { id: "meDev", kind: "profile", owner: "pool-dev", vendorPolicy: "any" },
  holdCursor: { id: "holdCursor", kind: "hold", owner: "cursor@laptop", vendorPolicy: "any" },
};

const snapshot: AccessSnapshot = {
  grants: [
    { poolId: "pool-dev", scopeId: "ctxd", level: "write" },
    { poolId: "pool-dev", scopeId: "shared-tools", level: "write" },
    { poolId: "pool-ops", scopeId: "project-b", level: "write" },
    { poolId: "pool-ops", scopeId: "shared-tools", level: "read" },
    { poolId: "pool-notes", scopeId: "notes", level: "write" },
    { poolId: "pool-private", scopeId: "private-a", level: "propose" },
  ],
  members: new Map([
    ["pool-dev", ["tag:coding", "client:claude-code@air"]],
    ["pool-ops", ["client:claude-desktop@laptop"]],
    ["pool-notes", ["client:claude-desktop@laptop"]],
    ["pool-private", ["client:local@studio"]],
  ]),
  poolVendorDefaults: new Map([["pool-private", "local-only"]]),
  temporary: [{ clientId: "claude-desktop@laptop", scopeId: "ctxd", level: "propose", expiresAt: 2_000 }],
};

const codex: ClientInfo = { id: "codex@laptop", vendor: "openai", tags: ["coding"] };
const desktop: ClientInfo = { id: "claude-desktop@laptop", vendor: "anthropic", tags: [] };
const cursor: ClientInfo = { id: "cursor@laptop", vendor: "other", tags: [] };
const local: ClientInfo = { id: "local@studio", vendor: "local", tags: [] };
const human: ClientInfo = { id: "human", vendor: "human", tags: [] };

describe("access evaluation (SPEC v4 10.5)", () => {
  it("grants through tag membership and denies by default", () => {
    expect(poolsOf(codex, snapshot)).toEqual(["pool-dev"]);
    expect(accessLevel(codex, scopes.ctxd!, snapshot, 0)).toBe("write");
    expect(accessLevel(codex, scopes.projectB!, snapshot, 0)).toBe("none");
    expect(accessLevel(codex, scopes.notes!, snapshot, 0)).toBe("none");
  });

  it("takes the highest level across pools for a shared scope", () => {
    expect(accessLevel(desktop, scopes.sharedTools!, snapshot, 0)).toBe("read");
    expect(accessLevel(codex, scopes.sharedTools!, snapshot, 0)).toBe("write");
  });

  it("honors temporary grants only until they expire", () => {
    expect(accessLevel(desktop, scopes.ctxd!, snapshot, 1_000)).toBe("propose");
    expect(accessLevel(desktop, scopes.ctxd!, snapshot, 3_000)).toBe("none");
  });

  it("lets every agent read global _me, writing only at propose", () => {
    expect(accessLevel(cursor, scopes.me!, snapshot, 0)).toBe("propose");
    expect(decideWrite(accessLevel(cursor, scopes.me!, snapshot, 0), false)).toEqual({ kind: "propose" });
  });

  it("holds every write from an unassigned agent outside its own holding scope", () => {
    expect(poolsOf(cursor, snapshot)).toEqual([]);
    expect(decideWrite(accessLevel(cursor, scopes.ctxd!, snapshot, 0), false)).toEqual({ kind: "hold" });
    expect(accessLevel(cursor, scopes.holdCursor!, snapshot, 0)).toBe("propose");
    expect(accessLevel(codex, scopes.holdCursor!, snapshot, 0)).toBe("none");
  });

  it("applies pool vendor defaults: local-only beats any grant for cloud agents", () => {
    expect(accessLevel(local, scopes.privateA!, snapshot, 0)).toBe("propose");
    const cloudInPrivate: ClientInfo = { id: "claude-code@air", vendor: "anthropic", tags: [] };
    const s2: AccessSnapshot = { ...snapshot, members: new Map([...snapshot.members, ["pool-private", ["client:claude-code@air"]]]) };
    expect(accessLevel(cloudInPrivate, scopes.privateA!, s2, 0)).toBe("none");
  });

  it("gives the human everything", () => {
    for (const s of Object.values(scopes)) expect(accessLevel(human, s, snapshot, 0)).toBe("write");
  });

  it("only lets pool members read that pool's profile", () => {
    expect(accessLevel(desktop, scopes.meNotes!, snapshot, 0)).toBe("read");
    expect(accessLevel(codex, scopes.meNotes!, snapshot, 0)).toBe("none");
  });
});

describe("session working set (SPEC v4 10.5)", () => {
  const all = Object.values(scopes);

  it("narrows a multi-pool agent to the current project's persona", () => {
    expect(workingSet(desktop, scopes.projectB!, all, snapshot, undefined, 0)).toEqual(["me", "project-b"]);
    expect(workingSet(desktop, scopes.notes!, all, snapshot, undefined, 0)).toEqual(["me", "meNotes", "notes"]);
  });

  it("gives an out-of-pool or unassigned agent only global _me", () => {
    expect(workingSet(codex, scopes.notes!, all, snapshot, undefined, 0)).toEqual(["me"]);
    expect(workingSet(cursor, scopes.ctxd!, all, snapshot, undefined, 0)).toEqual(["me"]);
  });

  it("honors an explicit pool override", () => {
    expect(workingSet(desktop, null, all, snapshot, "pool-notes", 0)).toEqual(["me", "meNotes"]);
  });

  it("includes the profile of each pool that grants the session scope", () => {
    expect(workingSet(codex, scopes.ctxd!, all, snapshot, undefined, 0)).toEqual(["ctxd", "me", "meDev"]);
  });
});

describe("per-session persona (SPEC v5 10.5)", () => {
  it("limits a multi-pool agent to its assumed pool", () => {
    // desktop belongs to pool-ops and pool-notes; assuming pool-ops makes notes unreachable
    expect(accessLevel(desktop, scopes.notes!, snapshot, 0, ["pool-ops"])).toBe("none");
    expect(accessLevel(desktop, scopes.projectB!, snapshot, 0, ["pool-ops"])).toBe("write");
    expect(accessLevel(desktop, scopes.notes!, snapshot, 0, ["pool-notes"])).toBe("write");
  });

  it("ignores assumed pools the agent is no longer a member of", () => {
    expect(accessLevel(codex, scopes.notes!, snapshot, 0, ["pool-notes"])).toBe("none");
  });

  it("keeps global _me readable under any persona", () => {
    expect(accessLevel(desktop, scopes.me!, snapshot, 0, ["pool-ops"])).toBe("propose");
  });
});

describe("traversal rule (SPEC v5 10.7)", () => {
  const target = { ref: "ctxd:private-a/01JABCDEFGHJKMNPQRSTVWXYZ0", kind: "fact", title: "secret-ish", summary: "x" };

  it("returns an opaque reference for unreadable targets", () => {
    expect(visibleOrRestricted(target, scopes.privateA!, codex, snapshot, ["pool-dev"], undefined, 0)).toEqual({
      ref: target.ref,
      restricted: true,
    });
  });

  it("returns an opaque reference for locked sealed targets even when readable", () => {
    expect(visibleOrRestricted(target, scopes.privateA!, local, snapshot, ["pool-private"], () => true, 0)).toEqual({
      ref: target.ref,
      restricted: true,
    });
    expect(visibleOrRestricted(target, scopes.privateA!, local, snapshot, ["pool-private"], () => false, 0)).toBe(target);
  });
});
