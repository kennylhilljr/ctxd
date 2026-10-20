import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { exportMarkdown, parseMarkdown, syncMirror } from "../../src/mirror/markdown.js";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctxd-mirror-")); scratch.push(root);
  const db = openDatabase(join(root, "ctxd.db"), { create: true });
  const nodeId = newId(); const humanId = newId(); const scopeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'node-a', 'home', ?)").run(nodeId, new Date().toISOString());
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), new Date().toISOString());
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(scopeId, new Date().toISOString());
  const ctx: WriteContext = { db, clock: new HlcClock(nodeId), nodeId, clientId: humanId, flags: new Map([["mirror", true]]) };
  return { root, mirror: join(root, "mirror"), db, ctx };
}

function createNote(f: ReturnType<typeof fixture>, kind: "note" | "decision" = "note") {
  const result = writeEntry(f.ctx, { scope: "sample-app", kind, title: "Mirror entry", body: "Original body", request_id: newId() } as never);
  if ("held" in result) throw new Error("unexpected held write");
  return result;
}

describe("Markdown export and mirror (Spec v9 section 12.1)", () => {
  it("exports frontmatter and body at the stable entry path", () => {
    const f = fixture(); createNote(f);
    expect(exportMarkdown(f.db, join(f.root, "export"))).toEqual({ written: 1 });
    const path = join(f.root, "export", "sample-app", "notes");
    const name = (f.db.prepare("SELECT slug FROM entries").get() as { slug: string }).slug;
    const text = readFileSync(join(path, `${name}.md`), "utf8");
    expect(text).toContain('kind: "note"');
    expect(text).toContain("# Mirror entry\n\nOriginal body");
  });

  it("round trips an edit through the event write path", () => {
    const f = fixture(); createNote(f); syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    const file = join(f.mirror, state.path);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited body"));
    const result = syncMirror(f.ctx, f.mirror);
    expect(result.applied).toBe(1);
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Edited body" });
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(2);
  });

  it("honors status and review date frontmatter as events", () => {
    const f = fixture(); createNote(f); syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    const file = join(f.mirror, state.path);
    const edited = readFileSync(file, "utf8").replace('status: "active"', 'status: "archived"').replace("review_after: null", 'review_after: "2027-01-02"');
    writeFileSync(file, edited);
    syncMirror(f.ctx, f.mirror);
    expect(f.db.prepare("SELECT status, review_after FROM entries").get()).toEqual({ status: "archived", review_after: "2027-01-02" });
    expect(f.db.prepare("SELECT op FROM events ORDER BY origin_seq").all()).toEqual([{ op: "create" }, { op: "status" }, { op: "status" }]);
  });

  it("writes a conflict copy for a stale revision and does not apply it", () => {
    const f = fixture(); createNote(f); syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    const file = join(f.mirror, state.path);
    const parsed = parseMarkdown(readFileSync(file, "utf8"), "fallback");
    writeFileSync(file, readFileSync(file, "utf8").replace(`rev: ${JSON.stringify(parsed.meta.rev)}`, 'rev: "1-stale"').replace("Original body", "Stale body"));
    const result = syncMirror(f.ctx, f.mirror);
    expect(result.conflicts).toBe(1);
    expect(existsSync(file.replace(/\.md$/, ".conflict.md"))).toBe(true);
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Original body" });
  });

  it("restores a deleted mirror file and records an archive request", () => {
    const f = fixture(); createNote(f); syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    rmSync(join(f.mirror, state.path));
    const result = syncMirror(f.ctx, f.mirror);
    expect(result.archiveRequests).toBe(1);
    expect(existsSync(join(f.mirror, state.path))).toBe(true);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM archive_requests").get() as { n: number }).n).toBe(1);
  });

  it("creates an entry from a new file in a scope folder", () => {
    const f = fixture();
    const dir = join(f.mirror, "sample-app", "notes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "new-note.md"), "---\nkind: \"note\"\ntitle: \"New mirror note\"\n---\n# New mirror note\n\nCreated in an editor\n");
    const result = syncMirror(f.ctx, f.mirror);
    expect(result.applied).toBe(1);
    expect(f.db.prepare("SELECT title, body FROM entries").get()).toEqual({ title: "New mirror note", body: "Created in an editor" });
    expect(syncMirror(f.ctx, f.mirror).applied).toBe(0);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n).toBe(1);
  });
});
