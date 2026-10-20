import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { confirmArchiveRequest, exportMarkdown, importMarkdown, parseMarkdown, syncMirror } from "../../src/mirror/markdown.js";

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

  it("allows a status-only edit to an immutable entry using status_rev", () => {
    const f = fixture(); createNote(f, "decision"); syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    const file = join(f.mirror, state.path);
    writeFileSync(file, readFileSync(file, "utf8").replace('status: "active"', 'status: "archived"'));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 1, conflicts: 0 });
    expect(f.db.prepare("SELECT status FROM entries").get()).toEqual({ status: "archived" });
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
    const entryId = (f.db.prepare("SELECT entry_id FROM entries").get() as { entry_id: string }).entry_id;
    confirmArchiveRequest(f.ctx, entryId);
    expect(f.db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(entryId)).toEqual({ status: "archived" });
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM archive_requests").get() as { n: number }).n).toBe(0);
    expect(f.db.prepare("SELECT op FROM events ORDER BY origin_seq DESC LIMIT 1").get()).toEqual({ op: "status" });
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

  it("never exports or mirrors plaintext from a sealed scope", () => {
    const f = fixture(); createNote(f);
    const poolId = newId();
    const scopeId = (f.db.prepare("SELECT scope_id FROM scopes WHERE name = 'sample-app'").get() as { scope_id: string }).scope_id;
    f.db.prepare("INSERT INTO pools (pool_id, name, storage, sealed_file, created_at) VALUES (?, 'pool-private', 'sealed', ?, ?)").run(poolId, `sealed/${poolId}.db`, new Date().toISOString());
    f.db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, 'write')").run(poolId, scopeId);
    expect(exportMarkdown(f.db, join(f.root, "export"))).toEqual({ written: 0 });
    expect(syncMirror(f.ctx, f.mirror).written).toBe(0);
    expect(existsSync(f.mirror)).toBe(false);
  });

  it("removes stale plaintext and tracking when a tracked entry becomes sealed", () => {
    const f = fixture(); createNote(f); syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    const file = join(f.mirror, state.path);
    const poolId = newId();
    const scopeId = (f.db.prepare("SELECT scope_id FROM scopes WHERE name = 'sample-app'").get() as { scope_id: string }).scope_id;
    f.db.prepare("INSERT INTO pools (pool_id, name, storage, sealed_file, created_at) VALUES (?, 'pool-private', 'sealed', ?, ?)").run(poolId, `sealed/${poolId}.db`, new Date().toISOString());
    f.db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, 'write')").run(poolId, scopeId);
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(file)).toBe(false);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM mirror_files").get()).toEqual({ n: 0 });
  });

  it("honors live mirror disablement and rejects symlink traversal", () => {
    const f = fixture(); createNote(f);
    f.ctx.flags = new Map([["mirror", false]]);
    expect(syncMirror(f.ctx, f.mirror)).toEqual({ written: 0, applied: 0, conflicts: 0, archiveRequests: 0 });
    const input = join(f.root, "input"); mkdirSync(input);
    const outside = join(f.root, "outside.md"); writeFileSync(outside, "# Outside\n\nBody\n");
    symlinkSync(outside, join(input, "linked.md"));
    expect(() => importMarkdown(f.ctx, input, "sample-app", true)).toThrow(/Symbolic links/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  });

  it("preflights sanitizer warnings and requires confirmation before import writes", () => {
    const f = fixture();
    const input = join(f.root, "warning-input"); mkdirSync(input);
    writeFileSync(join(input, "note.md"), "# Import\n\nKeep <private>remove me</private> text\n");
    const before = f.db.prepare("SELECT COUNT(*) AS n FROM events").get();
    const preview = importMarkdown(f.ctx, input, "sample-app", false);
    expect(preview).toMatchObject({ imported: 0, confirmationRequired: true });
    expect(preview.warnings).toHaveLength(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(before);
    expect(importMarkdown(f.ctx, input, "sample-app", false, true)).toMatchObject({ imported: 1, confirmationRequired: false });
  });
});
