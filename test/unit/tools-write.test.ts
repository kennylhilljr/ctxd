import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { ME_SCOPE_ID } from "../../src/core/kinds.js";
import { openDatabase } from "../../src/store/db.js";
import type { RequestContext } from "../../src/server/context.js";
import { contextWrite } from "../../src/tools/write.js";

/** contextWrite's W5.4 automatic skill sync trigger: a change to a skill entry schedules a sync through the detached worker, gated behind skills.native_sync. */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-tools-write-")), "ctxd.db");
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
  dataDir: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  db.prepare("INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, '_me', 'me', 'all', 'any', ?)").run(ME_SCOPE_ID, now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), now());
  const dataDir = mkdtempSync(join(tmpdir(), "ctxd-tools-write-data-"));
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, dataDir };
}

function ctxFor(f: Fixture, flags?: Map<string, boolean>): RequestContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId, clientName: "human", vendor: "human", assumedPools: [], flags, dataDir: f.dataDir, configPath: "/some/config.toml" };
}

const SKILL_BODY = `---\nname: deploy-runbook\ndescription: How to deploy.\n---\nSteps here.`;

function ticketFiles(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, "sessions")).filter((f) => f.startsWith("skill-sync.") && f.endsWith(".ticket.json"));
  } catch {
    return [];
  }
}

describe("contextWrite's automatic skill sync trigger (W5.4)", () => {
  it("schedules a skill sync when writing a skill entry with skills.native_sync on", async () => {
    const f = setup();
    const spawned: string[] = [];
    const result = (await contextWrite(
      ctxFor(f, new Map([["skills.native_sync", true]])),
      { scope: "_me", kind: "skill", title: "deploy-runbook", body: SKILL_BODY, request_id: newId() } as never,
      (ticketPath) => {
        spawned.push(ticketPath);
      },
    )) as { ref: string };

    expect(result.ref).toBeTruthy();
    expect(spawned).toHaveLength(1);
    const files = ticketFiles(f.dataDir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.dataDir, "sessions", files[0]!), "utf8"))).toMatchObject({ kind: "skill-sync" });
  });

  it("does not schedule a skill sync when skills.native_sync is off", async () => {
    const f = setup();
    const spawned: string[] = [];
    await contextWrite(
      ctxFor(f, new Map([["skills.native_sync", false]])),
      { scope: "_me", kind: "skill", title: "deploy-runbook", body: SKILL_BODY, request_id: newId() } as never,
      (ticketPath) => {
        spawned.push(ticketPath);
      },
    );

    expect(spawned).toEqual([]);
    expect(ticketFiles(f.dataDir)).toEqual([]);
  });

  it("does not schedule a skill sync for a non-skill write, even with the flag on", async () => {
    const f = setup();
    const spawned: string[] = [];
    await contextWrite(
      ctxFor(f, new Map([["skills.native_sync", true]])),
      { scope: "_me", kind: "note", title: "Not a skill", body: "x", request_id: newId() } as never,
      (ticketPath) => {
        spawned.push(ticketPath);
      },
    );

    expect(spawned).toEqual([]);
    expect(ticketFiles(f.dataDir)).toEqual([]);
  });
});
