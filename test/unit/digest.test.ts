import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { encodeHlc, HlcClock } from "../../src/core/hlc.js";
import { isoWeekBounds } from "../../src/core/dates.js";
import { isoWeek } from "../../src/journal/time.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { addRule, resolveEntry } from "../../src/store/review.js";
import { syncSignalsForScope } from "../../src/journal/sync.js";
import {
  assembleDigest,
  digestAlreadyWritten,
  lastCompletedWeek,
  runDueDigests,
  scopesWithActivity,
  writeDigest,
} from "../../src/journal/digest.js";
import type { CtxdConfig } from "../../src/config/config.js";

/** Weekly digest (SPEC v8 11.5). */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-digest-")), "ctxd.db");
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
  agentId: string;
  scopeId: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  const scopeId = newId();
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'notes', ?)").run(scopeId, now());
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    humanId,
    nodeId,
    newId(),
    now(),
  );
  const agentId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'agent-a', 'openai', ?, ?, ?)").run(
    agentId,
    nodeId,
    newId(),
    now(),
  );
  db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES ('pool-dev', 'pool-dev', ?)").run(now());
  db.prepare("INSERT INTO pool_members (pool_id, principal) VALUES ('pool-dev', ?)").run(`client:${agentId}`);
  db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES ('pool-dev', ?, 'write')").run(scopeId);
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, agentId, scopeId };
}

function ctxFor(f: Fixture): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.humanId };
}

function agentCtxFor(f: Fixture): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: f.agentId, assumedPools: ["pool-dev"] };
}

/** Overwrites an entry's created_hlc (and updated_hlc, by default) to a chosen physical time, so tests can place it in or out of a week without waiting. */
function placeAt(f: Fixture, entryId: string, atMs: number, field: "created_hlc" | "updated_hlc" = "created_hlc"): void {
  const hlc = encodeHlc({ physical: atMs, counter: 0, node: f.nodeId });
  f.db.prepare(`UPDATE entries SET ${field} = ? WHERE entry_id = ?`).run(hlc, entryId);
}

function note(f: Fixture, kind: string, title: string, extra: Record<string, unknown> = {}): { id: string; ref: string } {
  const result = writeEntry(ctxFor(f), { scope: "notes", kind, title, body: title, request_id: newId(), ...extra } as never);
  if ("held" in result) throw new Error("unexpected hold");
  return result;
}

describe("assembleDigest", () => {
  it("counts entries created in the week and excludes ones outside it", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { from } = isoWeekBounds(weekId);
    const inWeek = note(f, "fact", "Fact added this week");
    placeAt(f, inWeek.id, from + 3600_000);
    const outsideWeek = note(f, "fact", "Fact added long ago");
    placeAt(f, outsideWeek.id, from - 30 * 86_400_000);

    const { body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(body).toContain("1 fact");
    expect(body).not.toContain("2 fact");
  });

  it("lists milestones and breakthroughs by title", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { from } = isoWeekBounds(weekId);
    const m = note(f, "journal", "Shipped the thing", { significance: "milestone" });
    placeAt(f, m.id, from + 1000);

    const { body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(body).toContain("Milestones and breakthroughs");
    expect(body).toContain("Shipped the thing");
  });

  it("lists a decision made this week by its approved_hlc (review path, W5.1)", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { from } = isoWeekBounds(weekId);
    const result = writeEntry(agentCtxFor(f), { scope: "notes", kind: "decision", title: "Use Postgres", body: "b", request_id: newId() } as never) as { id: string; ref: string };
    placeAt(f, result.id, from - 30 * 86_400_000, "created_hlc"); // proposed long ago; approved_hlc (set below, "now") is what should matter
    resolveEntry(ctxFor(f), result.ref);

    const { body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(body).toContain("Decisions made");
    expect(body).toContain("Use Postgres");
  });

  it("falls back to created_hlc for a decision with no approval event (direct human write)", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { from } = isoWeekBounds(weekId);
    const d = note(f, "decision", "Use SQLite");
    placeAt(f, d.id, from + 1000);

    const { body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(body).toContain("Decisions made");
    expect(body).toContain("Use SQLite");
  });

  it("excludes a decision whose approval fell outside the week even though it was created inside it", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { from } = isoWeekBounds(weekId);
    addRule(ctxFor(f), "notes", { kind: "decision", client: "agent-a", action: "auto-accept" });
    const result = writeEntry(agentCtxFor(f), { scope: "notes", kind: "decision", title: "Use MySQL", body: "b", request_id: newId() } as never) as { id: string };
    // Auto-accepted, so approved_hlc was set at creation; push both outside the target week.
    placeAt(f, result.id, from - 30 * 86_400_000, "created_hlc");
    f.db.prepare("UPDATE entries SET approved_hlc = created_hlc WHERE entry_id = ?").run(result.id);

    const { body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(body).not.toContain("Use MySQL");
  });

  it("lists lessons, preferences and skills added", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { from } = isoWeekBounds(weekId);
    const l = note(f, "lesson", "Always check the clock in tests");
    placeAt(f, l.id, from + 1000);

    const { body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(body).toContain("Added");
    expect(body).toContain("Always check the clock in tests");
  });

  it("reports a blocker opened and resolved this week, with time to resolve", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const blocker = note(f, "journal", "Waiting on fixtures", { significance: "blocker" });
    note(f, "journal", "Fixtures landed", { links: [{ type: "resolved", ref: blocker.ref }] });

    const { body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(body).toContain("Blockers and incidents");
    expect(body).toContain("opened blocker: Waiting on fixtures");
    expect(body).toContain("resolved (0h): Waiting on fixtures");
  });

  it("excludes a blocker opened in an earlier week", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { from } = isoWeekBounds(weekId);
    const blocker = note(f, "journal", "Old blocker", { significance: "blocker" });
    placeAt(f, blocker.id, from - 30 * 86_400_000);
    syncSignalsForScope(f.db, f.scopeId);

    const { body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(body).not.toContain("Old blocker");
  });

  it("counts an auto-tagged commit entry and an auto-tagged session entry separately", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    note(f, "journal", "Session ended: human", { tags: ["auto"] });
    note(f, "journal", "Fixed the bug", { tags: ["auto"], links: [{ type: "points_to", ref: "commit:abc123" }] });

    const { body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(body).toContain("Auto: 1 session(s), 1 commit(s)");
  });

  it("returns a plain message when there is no activity in the week", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { empty, body } = assembleDigest(f.db, f.scopeId, "notes", weekId);
    expect(empty).toBe(true);
    expect(body).toBe("No new activity this week.");
  });
});

describe("digestAlreadyWritten and writeDigest", () => {
  it("is false before writing and true after", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    expect(digestAlreadyWritten(f.db, f.humanId, f.scopeId, weekId)).toBe(false);
    writeDigest(ctxFor(f), f.scopeId, "notes", weekId);
    expect(digestAlreadyWritten(f.db, f.humanId, f.scopeId, weekId)).toBe(true);
  });

  it("writes a journal entry tagged digest and the week id", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { ref } = writeDigest(ctxFor(f), f.scopeId, "notes", weekId);
    const row = f.db.prepare("SELECT kind, significance, tags FROM entries WHERE entry_id LIKE ?").get(`%${ref.split("/")[1]}%`) as
      | { kind: string; significance: string; tags: string }
      | undefined;
    expect(row?.kind).toBe("journal");
    expect(row?.significance).toBe("routine");
    expect(JSON.parse(row?.tags ?? "[]")).toEqual(["digest", weekId]);
  });
});

describe("scopesWithActivity", () => {
  it("lists only scopes with an event in the window", () => {
    const f = setup();
    const weekId = isoWeek(Date.now());
    const { from, to } = isoWeekBounds(weekId);
    note(f, "fact", "Something");
    const quietScopeId = newId();
    f.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'quiet', ?)").run(quietScopeId, now());

    const names = scopesWithActivity(f.db, from, to).map((s) => s.name);
    expect(names).toContain("notes");
    expect(names).not.toContain("quiet");
  });
});

describe("lastCompletedWeek", () => {
  it("is always a week that has already closed", () => {
    const at = Date.now();
    const weekId = lastCompletedWeek(at);
    const { to } = isoWeekBounds(weekId);
    expect(to).toBeLessThanOrEqual(at);
  });
});

describe("runDueDigests", () => {
  function configFor(nodeName: string, digestNode: string, digestWeekday: CtxdConfig["journal"]["digest_weekday"]): CtxdConfig {
    return {
      node: { name: nodeName, role: "home", data_dir: "~/x" },
      mcp: { listen: "127.0.0.1:1" },
      sync: { listen: "127.0.0.1:2", interval_seconds: 120 },
      brief: { micro_tokens: 1, normal_tokens: 1, full_tokens: 1 },
      nudge: { enabled: false, min_minutes_between: 1, turns_threshold: 1, completion_markers: [] },
      scope_map: {},
      backup: { age_recipient: "", copy_to: "" },
      hooks: { bypass_patterns: [], session_start_max_chars: 1, crash_grace_minutes: 1 },
      mirror: { enabled: false, dir: "~/x" },
      journal: { digest_node: digestNode, digest_weekday: digestWeekday },
      features: {},
    };
  }

  // Every check below passes "UTC" explicitly, both to runDueDigests and to the assertions'
  // own isoWeek/digestAlreadyWritten calls, so the test is deterministic regardless of the
  // machine's local time zone (runDueDigests otherwise uses the system default).

  it("does nothing on a node other than journal.digest_node", () => {
    const f = setup();
    note(f, "fact", "Something");
    const at = Date.UTC(2026, 9, 18, 19, 0, 0); // a Sunday, 19:00 UTC
    runDueDigests(ctxFor(f), configFor("air", "studio", "sunday"), at, "UTC");
    expect(digestAlreadyWritten(f.db, f.humanId, f.scopeId, isoWeek(at, "UTC"), "UTC")).toBe(false);
  });

  it("writes a digest for every active scope on digest_weekday after 18:00, and is a no-op on a second check", () => {
    const f = setup();
    const at = Date.UTC(2026, 9, 18, 19, 0, 0); // a Sunday, 19:00 UTC
    expect(new Date(at).getUTCDay()).toBe(0);
    const activity = note(f, "fact", "Something");
    placeAt(f, activity.id, at - 3600_000); // this week, not whenever the test actually ran
    // scopesWithActivity reads events.hlc, not entries.created_hlc, so the event needs backdating too.
    f.db
      .prepare("UPDATE events SET hlc = ? WHERE entry_id = ?")
      .run(encodeHlc({ physical: at - 3600_000, counter: 0, node: f.nodeId }), activity.id);
    const config = configFor("air", "air", "sunday");

    runDueDigests(ctxFor(f), config, at, "UTC");
    const weekId = isoWeek(at, "UTC");
    expect(digestAlreadyWritten(f.db, f.humanId, f.scopeId, weekId, "UTC")).toBe(true);

    const before = f.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE scope_id = ? AND kind = 'journal'").get(f.scopeId) as { n: number };
    runDueDigests(ctxFor(f), config, at + 1000, "UTC");
    const after = f.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE scope_id = ? AND kind = 'journal'").get(f.scopeId) as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("does nothing before 18:00 local on digest_weekday", () => {
    const f = setup();
    note(f, "fact", "Something");
    const at = Date.UTC(2026, 9, 18, 10, 0, 0); // same Sunday, but 10:00 UTC
    runDueDigests(ctxFor(f), configFor("air", "air", "sunday"), at, "UTC");
    expect(digestAlreadyWritten(f.db, f.humanId, f.scopeId, isoWeek(at, "UTC"), "UTC")).toBe(false);
  });
});
