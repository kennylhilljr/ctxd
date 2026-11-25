import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { confirmArchiveRequest, exportMarkdown, importMarkdown, parseMarkdown, syncMirror } from "../../src/mirror/markdown.js";
import { checkMirrorSkips } from "../../src/cli/doctor.js";

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

  it("imports a new file once when moving it to its canonical path fails (#83)", () => {
    const f = fixture();
    const count = (table: string) => (f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    mkdirSync(join(f.mirror, "sample-app"), { recursive: true });
    const source = join(f.mirror, "sample-app", "new-note.md");
    writeFileSync(source, "---\nkind: \"note\"\ntitle: \"Retry note\"\n---\n# Retry note\n\nBody\n");
    // A regular file where the canonical notes/ folder belongs makes mkdir (and the export) fail.
    const blocker = join(f.mirror, "sample-app", "notes");
    writeFileSync(blocker, "not a directory");
    for (let i = 0; i < 3; i++) {
      try { syncMirror(f.ctx, f.mirror); } catch { /* blocked canonical folder */ }
    }
    expect(count("entries")).toBe(1);
    expect(count("events")).toBe(1);
    expect(existsSync(source)).toBe(true);

    rmSync(blocker);
    syncMirror(f.ctx, f.mirror);
    expect(count("entries")).toBe(1);
    expect(count("events")).toBe(1);
    expect(existsSync(source)).toBe(false);
    expect(f.db.prepare("SELECT title FROM entries").get()).toEqual({ title: "Retry note" });
    syncMirror(f.ctx, f.mirror);
    expect(count("entries")).toBe(1);
  });

  it("reuses the first entry when the rename itself fails once (#83)", () => {
    const f = fixture();
    const count = (table: string) => (f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const notes = join(f.mirror, "sample-app", "notes");
    mkdirSync(notes, { recursive: true });
    const source = join(f.mirror, "sample-app", "renamed.md");
    writeFileSync(source, "---\nkind: \"note\"\ntitle: \"Rename retry\"\n---\n# Rename retry\n\nBody\n");
    // A read-only notes/ folder lets mkdir succeed but makes the rename into it fail.
    chmodSync(notes, 0o555);
    try {
      try { syncMirror(f.ctx, f.mirror); } catch { /* read-only canonical folder */ }
      expect(existsSync(source)).toBe(true);
      expect(count("entries")).toBe(1);
    } finally {
      chmodSync(notes, 0o755);
    }
    const [first] = f.db.prepare("SELECT entry_id FROM entries").all() as { entry_id: string }[];
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(source)).toBe(false);
    expect(f.db.prepare("SELECT entry_id FROM entries").all()).toEqual([first]);
    expect(count("events")).toBe(1);
  });

  it("records a skip, not a duplicate, for a file whose earlier import was archived (#83)", () => {
    const f = fixture();
    const count = () => (f.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
    const content = "---\nkind: \"note\"\ntitle: \"Again\"\n---\n# Again\n\nBody\n";
    mkdirSync(join(f.mirror, "sample-app"), { recursive: true });
    const source = join(f.mirror, "sample-app", "again.md");
    writeFileSync(source, content);
    syncMirror(f.ctx, f.mirror);
    const { entry_id: first } = f.db.prepare("SELECT entry_id FROM entries").get() as { entry_id: string };
    const notes = join(f.mirror, "sample-app", "notes");
    for (const file of readdirSync(notes)) rmSync(join(notes, file));
    syncMirror(f.ctx, f.mirror);
    confirmArchiveRequest(f.ctx, first);

    writeFileSync(source, content);
    syncMirror(f.ctx, f.mirror);
    syncMirror(f.ctx, f.mirror);
    expect(count()).toBe(1);
    expect(existsSync(source)).toBe(true);
    expect(f.db.prepare("SELECT code, attempts FROM mirror_skips").get()).toEqual({ code: "NOT_ALLOWED", attempts: 2 });

    writeFileSync(source, content.replace("Body", "Edited body"));
    syncMirror(f.ctx, f.mirror);
    expect(count()).toBe(2);
    expect(existsSync(source)).toBe(false);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_skips").get() as { n: number }).n).toBe(0);
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

  it("records a new file refused for a sealed scope in mirror_skips instead of dropping it silently (#72)", () => {
    const f = fixture();
    const poolId = newId();
    const scopeId = (f.db.prepare("SELECT scope_id FROM scopes WHERE name = 'sample-app'").get() as { scope_id: string }).scope_id;
    f.db.prepare("INSERT INTO pools (pool_id, name, storage, sealed_file, created_at) VALUES (?, 'pool-private', 'sealed', ?, ?)").run(poolId, `sealed/${poolId}.db`, new Date().toISOString());
    f.db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, 'write')").run(poolId, scopeId);
    const dir = join(f.mirror, "sample-app", "notes");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "new-note.md");
    writeFileSync(file, "---\nkind: \"note\"\n---\n# Sealed note\n\nBody\n");

    expect(syncMirror(f.ctx, f.mirror).applied).toBe(0);
    expect(f.db.prepare("SELECT path, code, attempts FROM mirror_skips").all()).toEqual([{ path: join("sample-app", "notes", "new-note.md"), code: "SCOPE_FORBIDDEN", attempts: 1 }]);
    syncMirror(f.ctx, f.mirror);
    expect(f.db.prepare("SELECT attempts FROM mirror_skips").get()).toEqual({ attempts: 2 });
    expect(checkMirrorSkips(f.db)).toMatchObject({ ok: false, detail: expect.stringMatching(/1 file\(s\) not imported: .*new-note\.md: SCOPE_FORBIDDEN/) });
    expect(existsSync(file)).toBe(true);

    rmSync(file);
    syncMirror(f.ctx, f.mirror);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_skips").get() as { n: number }).n).toBe(0);
    expect(checkMirrorSkips(f.db)).toMatchObject({ ok: true });
  });

  it("sanitizes a skipped file's name in ctxd doctor, on one line (#72, TS-AC-2)", () => {
    const f = fixture();
    const token = "ghp_" + "a".repeat(36);
    f.db.prepare("INSERT INTO mirror_skips (path_key, path, code, reason, first_skipped_at, last_skipped_at) VALUES ('k', ?, 'INVALID_FILE', ?, 't', 't')").run(`sample-app/notes/${token}\nok: fake.md`, "a\u2028b");
    const detail = checkMirrorSkips(f.db).detail;
    expect(detail).not.toContain(token);
    expect(detail).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it("never stores a secret from a skipped file's name (#72, TS-AC-2)", () => {
    const f = fixture();
    const token = "ghp_" + "b".repeat(36);
    const dir = join(f.mirror, "sample-app", "notes");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${token}.md`);
    writeFileSync(file, "---\nkind: \"not-a-kind\"\n---\nBody\n");
    syncMirror(f.ctx, f.mirror);
    const rows = f.db.prepare("SELECT path, reason FROM mirror_skips").all() as { path: string; reason: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    syncMirror(f.ctx, f.mirror);
    expect(f.db.prepare("SELECT attempts FROM mirror_skips").get()).toEqual({ attempts: 2 }); // same row, matched by the path hash
    rmSync(file);
    syncMirror(f.ctx, f.mirror);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_skips").get() as { n: number }).n).toBe(0);
  });

  it("keeps one skip row per file even when their redacted names collide (#72)", () => {
    const f = fixture();
    const dir = join(f.mirror, "sample-app", "notes");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, `${"ghp_" + "c".repeat(36)}.md`);
    const b = join(dir, `${"ghp_" + "d".repeat(36)}.md`);
    writeFileSync(a, "---\nkind: \"not-a-kind\"\n---\nBody\n");
    writeFileSync(b, "---\nkind: \"not-a-kind\"\n---\nBody\n");
    syncMirror(f.ctx, f.mirror);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_skips").get() as { n: number }).n).toBe(2);
    rmSync(a);
    syncMirror(f.ctx, f.mirror);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_skips").get() as { n: number }).n).toBe(1);
  });

  it("clears a skip once the file imports (#72)", () => {
    const f = fixture();
    const dir = join(f.mirror, "sample-app", "notes");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "new-note.md");
    writeFileSync(file, "---\nkind: \"not-a-kind\"\n---\n# Bad kind\n\nBody\n");
    syncMirror(f.ctx, f.mirror);
    expect(f.db.prepare("SELECT code FROM mirror_skips").get()).toEqual({ code: "INVALID_FILE" });
    writeFileSync(file, "---\nkind: \"note\"\n---\n# Good kind\n\nBody\n");
    expect(syncMirror(f.ctx, f.mirror).applied).toBe(1);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_skips").get() as { n: number }).n).toBe(0);
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

describe("mirror paths stay inside the mirror directory (issue 68)", () => {
  it("refuses to export an entry whose stored scope name would escape the output directory", () => {
    const f = fixture(); createNote(f);
    // A row stored before scope names were validated, or by a peer before materialize checked them.
    f.db.prepare("UPDATE scopes SET name = '../escape' WHERE name = 'sample-app'").run();
    expect(() => exportMarkdown(f.db, join(f.root, "export"))).toThrow(/escapes the mirror directory/);
    expect(existsSync(join(f.root, "escape"))).toBe(false);
  });

  it("refuses to write a mirror file for a slug containing ../", () => {
    const f = fixture(); createNote(f);
    f.db.prepare("UPDATE entries SET slug = '../../../escaped'").run();
    expect(() => syncMirror(f.ctx, f.mirror)).toThrow(/escapes the mirror directory/);
    expect(existsSync(join(f.root, "escaped.md"))).toBe(false);
  });

  it("refuses to unlink a tracked path outside the mirror directory", () => {
    const f = fixture(); const { id } = createNote(f) as { id: string };
    const victim = join(f.root, "victim.md"); writeFileSync(victim, "keep me\n");
    f.db.prepare("UPDATE entries SET status = 'deleted' WHERE entry_id = ?").run(id);
    f.db.prepare("INSERT INTO mirror_files (path, entry_id, content_rev, file_hash, written_at) VALUES ('../victim.md', ?, 'r', 'h', ?)").run(id, new Date().toISOString());
    expect(() => syncMirror(f.ctx, f.mirror)).toThrow(/escapes the mirror directory/);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  });

  it("refuses to write through a symlinked folder inside the output directory", () => {
    const f = fixture(); createNote(f);
    const outside = join(f.root, "outside"); mkdirSync(outside);
    const out = join(f.root, "export");
    mkdirSync(join(out, "sample-app"), { recursive: true });
    symlinkSync(outside, join(out, "sample-app", "notes"));
    expect(() => exportMarkdown(f.db, out)).toThrow(/Symbolic links are not allowed in the mirror/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses to unlink a tracked file through a symlinked folder inside the mirror", () => {
    const f = fixture(); const { id } = createNote(f) as { id: string }; syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    const outside = join(f.root, "outside"); mkdirSync(outside);
    const victim = join(outside, state.path.split("/").pop()!); writeFileSync(victim, "keep me\n");
    rmSync(join(f.mirror, "sample-app", "notes"), { recursive: true });
    symlinkSync(outside, join(f.mirror, "sample-app", "notes"));
    f.db.prepare("UPDATE entries SET status = 'deleted' WHERE entry_id = ?").run(id);
    expect(() => syncMirror(f.ctx, f.mirror)).toThrow(/Symbolic links are not allowed in the mirror/);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  });
});
