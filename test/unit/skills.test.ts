import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { buildCatalog, catalogLine, parseSkill, renderSyncedSkill, skillSummary } from "../../src/skills/skillmd.js";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { ME_SCOPE_ID } from "../../src/core/kinds.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { clientSkillsDir, syncSkillsForClient } from "../../src/skills/sync.js";
import { ensureImportClient, importSkillsFrom } from "../../src/skills/importSkills.js";

const BODY = `---
name: release-checklist
description: >
  How to cut a release of sample-app: version bump, changelog,
  tag and verification. Use when asked to release.
when_to_use: "Before tagging"
allowed-tools:
  - Bash(git tag:*)
  - Bash(npm publish:*)
---
# Release checklist

1. Run the tests.
`;

describe("SKILL.md validation (SPEC v6 4.3)", () => {
  it("parses name, a folded description and keeps other keys", () => {
    const s = parseSkill("release-checklist", BODY);
    expect(s.name).toBe("release-checklist");
    expect(s.description).toBe(
      "How to cut a release of sample-app: version bump, changelog, tag and verification. Use when asked to release.",
    );
    expect(s.keys).toEqual(["name", "description", "when_to_use", "allowed-tools"]);
    expect(s.instructions).toContain("# Release checklist");
    expect(skillSummary(s).length).toBeLessThanOrEqual(200);
  });

  it.each([
    ["Release", BODY, /title must be the skill name/],
    ["release--checklist", BODY, /title must be the skill name/],
    ["other-name", BODY, /must equal the title/],
    ["release-checklist", "# no frontmatter", /must start with/],
    ["release-checklist", "---\nname: release-checklist\n", /not closed/],
    ["release-checklist", "---\nname: release-checklist\n---\nbody", /needs a description/],
    ["release-checklist", `---\nname: release-checklist\ndescription: ${"d".repeat(1025)}\n---\n`, /1 to 1024/],
  ])("rejects title %s", (title, body, err) => {
    expect(() => parseSkill(title, body)).toThrow(err);
  });

  it("accepts quoted values and CRLF line endings", () => {
    const s = parseSkill("a-b", "---\r\nname: 'a-b'\r\ndescription: \"Does a thing\"\r\n---\r\nText\r\n");
    expect(s.description).toBe("Does a thing");
  });
});

describe("catalog and sync (SPEC v6 11.1, 12.2)", () => {
  it("formats catalog lines and respects the budget", () => {
    const line = catalogLine({ name: "x", description: "word ".repeat(60) }, "claude-code@laptop");
    expect(line.startsWith("- x: ")).toBe(true);
    expect(line.endsWith("(claude-code@laptop)")).toBe(true);
    const { text, omitted } = buildCatalog([line, line, line, line, line, line], 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(omitted).toBeGreaterThan(0);
  });

  it("strips allowed-tools by default and marks the file as managed", () => {
    const out = renderSyncedSkill(BODY, "ctxd:_me/01JAB");
    expect(out).not.toContain("allowed-tools");
    expect(out).not.toContain("npm publish");
    expect(out).toContain("when_to_use");
    expect(out).toContain("<!-- ctxd:_me/01JAB: managed by ctxd");
    expect(parseSkill("release-checklist", out).name).toBe("release-checklist");
    expect(renderSyncedSkill(BODY, "r", true)).toContain("allowed-tools");
  });
});

describe("SKILL.md edge cases (review findings)", () => {
  it("closes frontmatter only on an exact --- line", () => {
    expect(() => parseSkill("a", "---\nname: a\ndescription: d\n---more\n")).toThrow(/not closed/);
  });

  it("handles block scalar modifiers, plain continuations and comments", () => {
    expect(parseSkill("a", "---\nname: a\ndescription: >+\n  folded\n  text\n---\n").description).toBe("folded text");
    expect(parseSkill("a", "---\nname: a\ndescription: starts here\n  and continues\n---\n").description).toBe(
      "starts here and continues",
    );
    expect(parseSkill("a", "---\nname: a # the name\ndescription: d\n---\n").name).toBe("a");
    expect(parseSkill("a", '---\nname: a\ndescription: "keeps # inside quotes"\n---\n').description).toBe(
      "keeps # inside quotes",
    );
  });

  it.each([
    '---\nname: a\ndescription: d\n"allowed-tools": Bash(rm:*)\n---\nx',
    "---\nname: a\ndescription: d\nallowed-tools : Bash\n---\nx",
    "---\nname: a\nallowed-tools:\n  - Bash\n\n  - Read\ndescription: d\n---\nx",
  ])("strips every form of allowed-tools: %#", (body) => {
    const out = renderSyncedSkill(body, "r");
    expect(out.toLowerCase()).not.toContain("allowed-tools");
    expect(out).not.toMatch(/Bash|Read/);
    expect(parseSkill("a", out).description).toBe("d");
  });
});

/** Native skill sync (SPEC v8 12.2). */

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "ctxd-skills-")), "ctxd.db");
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
  home: string;
}

function setup(): Fixture {
  const db = freshDb();
  const nodeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'air', 'home', ?)").run(nodeId, now());
  db.prepare("INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, '_me', 'me', 'all', 'any', ?)").run(
    ME_SCOPE_ID,
    now(),
  );
  const humanId = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(
    humanId,
    nodeId,
    newId(),
    now(),
  );
  const home = mkdtempSync(join(tmpdir(), "ctxd-skills-home-"));
  return { db, clock: new HlcClock(nodeId), nodeId, humanId, home };
}

function ctxFor(f: Fixture, clientId: string): WriteContext {
  return { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId };
}

const SKILL_BODY = (name: string, desc = "How to do it."): string => `---\nname: ${name}\ndescription: ${desc}\n---\nSteps here.`;

function writeSkill(f: Fixture, name: string, body: string = SKILL_BODY(name)): { id: string; ref: string } {
  const result = writeEntry(ctxFor(f, f.humanId), { scope: "_me", kind: "skill", title: name, body, request_id: newId() } as never);
  if ("held" in result) throw new Error("unexpected hold");
  return result;
}

describe("clientSkillsDir", () => {
  it("knows claude-code's folder but not codex's (SPEC v8 open issue 16: unverified)", () => {
    expect(clientSkillsDir("claude-code", "/home/x")).toBe("/home/x/.claude/skills");
    expect(clientSkillsDir("codex", "/home/x")).toBeNull();
  });
});

describe("syncSkillsForClient", () => {
  it("writes a new skill into the client's folder and records it in skill_syncs", () => {
    const f = setup();
    const skill = writeSkill(f, "deploy-runbook");

    const report = syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    expect(report.written).toEqual(["deploy-runbook"]);
    const target = join(f.home, ".claude", "skills", "deploy-runbook", "SKILL.md");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain(skill.ref);

    const row = f.db.prepare("SELECT path FROM skill_syncs WHERE client = 'claude-code' AND skill_entry = ?").get(skill.id) as { path: string };
    expect(row.path).toBe(target);
  });

  it("strips allowed-tools unless keep_allowed_tools is set", () => {
    const f = setup();
    writeSkill(f, "with-tools", "---\nname: with-tools\ndescription: d.\nallowed-tools: Bash\n---\nBody.");
    syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    const target = join(f.home, ".claude", "skills", "with-tools", "SKILL.md");
    expect(readFileSync(target, "utf8")).not.toContain("allowed-tools");
  });

  it("is a no-op on a second run with nothing changed", () => {
    const f = setup();
    writeSkill(f, "deploy-runbook");
    syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    const report = syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    expect(report.written).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("never overwrites a folder it did not write (a stranger)", () => {
    const f = setup();
    writeSkill(f, "deploy-runbook");
    const target = join(f.home, ".claude", "skills", "deploy-runbook", "SKILL.md");
    mkdirSync(join(f.home, ".claude", "skills", "deploy-runbook"), { recursive: true });
    writeFileSync(target, "not ctxd's file");

    const report = syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    expect(report.written).toEqual([]);
    expect(report.skipped[0]?.reason).toContain("was not written by ctxd");
    expect(readFileSync(target, "utf8")).toBe("not ctxd's file");
  });

  it("skips a file that was edited locally since the last sync", () => {
    const f = setup();
    writeSkill(f, "deploy-runbook");
    syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    const target = join(f.home, ".claude", "skills", "deploy-runbook", "SKILL.md");
    writeFileSync(target, "locally edited content");

    const report = syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    expect(report.written).toEqual([]);
    expect(report.skipped[0]?.reason).toContain("edited locally");
    expect(readFileSync(target, "utf8")).toBe("locally edited content");
  });

  it("removes a synced file for a skill that is no longer active, and its folder if now empty", () => {
    const f = setup();
    const skill = writeSkill(f, "deploy-runbook");
    syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    const target = join(f.home, ".claude", "skills", "deploy-runbook", "SKILL.md");
    expect(existsSync(target)).toBe(true);

    f.db.prepare("UPDATE entries SET status = 'archived' WHERE entry_id = ?").run(skill.id);
    const report = syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    expect(report.removed).toEqual([target]);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(f.home, ".claude", "skills", "deploy-runbook"))).toBe(false);
    expect(f.db.prepare("SELECT 1 FROM skill_syncs WHERE skill_entry = ?").get(skill.id)).toBeUndefined();
  });

  it("syncs only the earliest of two same-named skills in the same scope (SPEC 4.3 name clash)", () => {
    const f = setup();
    const first = writeSkill(f, "deploy-runbook", SKILL_BODY("deploy-runbook", "First version."));
    writeSkill(f, "deploy-runbook", SKILL_BODY("deploy-runbook", "Second, clashing version."));

    const report = syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    expect(report.written).toEqual(["deploy-runbook"]);
    const row = f.db.prepare("SELECT skill_entry FROM skill_syncs WHERE client = 'claude-code'").get() as { skill_entry: string };
    expect(row.skill_entry).toBe(first.id);
  });

  it("reports codex as unsupported rather than guessing its folder", () => {
    const f = setup();
    writeSkill(f, "deploy-runbook");
    const report = syncSkillsForClient(f.db, "codex", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    expect(report.written).toEqual([]);
    expect(report.skipped[0]?.reason).toContain("not yet confirmed");
  });
});

describe("ensureImportClient", () => {
  it("is idempotent", () => {
    const f = setup();
    const a = ensureImportClient(f.db, f.nodeId);
    const b = ensureImportClient(f.db, f.nodeId);
    expect(a).toBe(b);
  });
});

describe("importSkillsFrom", () => {
  function writeClientSkillFile(f: Fixture, name: string, body: string = SKILL_BODY(name)): void {
    const dir = join(f.home, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf8");
  }

  it("creates a proposed skill entry for each file found", () => {
    const f = setup();
    writeClientSkillFile(f, "deploy-runbook");
    const ctx = { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: ensureImportClient(f.db, f.nodeId) };

    const result = importSkillsFrom(ctx, "claude-code", "_me", false, f.home);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.name).toBe("deploy-runbook");
    const row = f.db.prepare("SELECT status FROM entries WHERE skill_name = 'deploy-runbook'").get() as { status: string };
    expect(row.status).toBe("proposed");
  });

  it("skips a file whose frontmatter is invalid, without aborting the rest", () => {
    const f = setup();
    writeClientSkillFile(f, "broken", "not valid SKILL.md");
    writeClientSkillFile(f, "fine");
    const ctx = { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: ensureImportClient(f.db, f.nodeId) };

    const result = importSkillsFrom(ctx, "claude-code", "_me", false, f.home);
    expect(result.imported.map((i) => i.name)).toEqual(["fine"]);
    expect(result.skipped.map((s) => s.name)).toEqual(["broken"]);
  });

  it("dry run reports without writing anything", () => {
    const f = setup();
    writeClientSkillFile(f, "deploy-runbook");
    const ctx = { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: ensureImportClient(f.db, f.nodeId) };

    const result = importSkillsFrom(ctx, "claude-code", "_me", true, f.home);
    expect(result.imported.map((i) => i.name)).toEqual(["deploy-runbook"]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE kind = 'skill'").get()).toEqual({ n: 0 });
  });

  it("skips a file ctxd itself wrote via sync, rather than re-importing its own output (regression: caught in live verification)", () => {
    const f = setup();
    writeSkill(f, "deploy-runbook");
    syncSkillsForClient(f.db, "claude-code", [ME_SCOPE_ID], new Map([[ME_SCOPE_ID, "_me"]]), false, f.home);
    writeClientSkillFile(f, "other-skill");
    const ctx = { db: f.db, clock: f.clock, nodeId: f.nodeId, clientId: ensureImportClient(f.db, f.nodeId) };

    const result = importSkillsFrom(ctx, "claude-code", "_me", false, f.home);
    expect(result.imported.map((i) => i.name)).toEqual(["other-skill"]);
    expect(result.skipped[0]).toEqual({ name: "deploy-runbook", reason: expect.stringContaining("already managed by ctxd") });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE kind = 'skill' AND skill_name = 'deploy-runbook'").get()).toEqual({ n: 1 });
  });
});
