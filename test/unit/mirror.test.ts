import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";
import { confirmArchiveRequest, exportMarkdown, importMarkdown, parseMarkdown, syncMirror } from "../../src/mirror/markdown.js";
import { checkMirrorSkips } from "../../src/cli/doctor.js";
import { setEntryStatus } from "../../src/store/tidy.js";
import { formatRef } from "../../src/model/refs.js";
import { purgeEntry } from "../../src/store/purge.js";
import { SealedPoolStore, TestDatabaseProvider } from "../../src/sealed/store.js";
import { TestKeyProvider } from "../../src/sealed/key-provider.js";

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

function count(f: ReturnType<typeof fixture>, table: "entries" | "events"): number {
  return (f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
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

  // Simulates a stop after the export loop wrote the file but before it recorded it in mirror_files.
  function writtenButUntracked(f: ReturnType<typeof fixture>, kind: "note" | "decision" = "note"): string {
    createNote(f, kind); syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    f.db.prepare("DELETE FROM mirror_files").run();
    return join(f.mirror, state.path);
  }

  it("keeps an edit to a written but untracked mirror file after a stop (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited while stopped"));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 1, conflicts: 0 });
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Edited while stopped" });
    expect(readFileSync(file, "utf8")).toContain("Edited while stopped");
    expect(count(f, "entries")).toBe(1);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_files").get() as { n: number }).n).toBe(1);
  });

  it("re-tracks an unedited untracked mirror file without new events (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 0 });
    expect(count(f, "events")).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_files").get() as { n: number }).n).toBe(1);
  });

  it("keeps a conflict copy when the entry changed while an untracked file was edited (#88, FS-AC-4)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    const row = f.db.prepare("SELECT entry_id, content_rev FROM entries").get() as { entry_id: string; content_rev: string };
    writeEntry(f.ctx, { scope: "sample-app", id: row.entry_id, expected_rev: row.content_rev, kind: "note", title: "Mirror entry", body: "Changed elsewhere", request_id: newId() } as never);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited while stopped"));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 1 });
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Changed elsewhere" });
    expect(readFileSync(file.replace(/\.md$/, ".conflict.md"), "utf8")).toContain("Edited while stopped");
  });

  it("keeps a conflict copy for an untracked edit to an immutable entry (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f, "decision");
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited while stopped"));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 1 });
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Original body" });
    expect(existsSync(file.replace(/\.md$/, ".conflict.md"))).toBe(true);
  });

  it("finds an untracked file's entry by its path, ignoring an edited ref (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    const text = readFileSync(file, "utf8");
    const ref = parseMarkdown(text, "fallback").meta.ref!;
    writeFileSync(file, text.replace(ref, "ctxd:sample-app/01ARZ3NDEKTSV4RRFFQ69G5FAV").replace("Original body", "Edited while stopped"));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 1, conflicts: 0 });
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Edited while stopped" });
    expect(readFileSync(file, "utf8")).toContain(`ref: ${JSON.stringify(ref)}`);
  });

  it("keeps a refused untracked edit as a conflict copy (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited while stopped").replace(/^tags: .*$/m, "tags: 5"));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 1 });
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Original body" });
    expect(readFileSync(file.replace(/\.md$/, ".conflict.md"), "utf8")).toContain("Edited while stopped");
    expect(f.db.prepare("SELECT reason FROM mirror_conflicts").get()).toMatchObject({ reason: expect.stringContaining("could not be applied") });
  });

  it("applies none of an untracked edit that is refused part way (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited while stopped").replace("review_after: null", 'review_after: {"bad":1}'));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 1 });
    expect(f.db.prepare("SELECT body, review_after FROM entries").get()).toEqual({ body: "Original body", review_after: null });
    expect(count(f, "events")).toBe(1);
    expect(readFileSync(file.replace(/\.md$/, ".conflict.md"), "utf8")).toContain("Edited while stopped");
  });

  it("keeps the write path's rejection record for a refused untracked edit (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "AKIAABCDEFGHIJKLMNOP is our access key"));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 1 });
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Original body" });
    expect(f.db.prepare("SELECT code FROM rejections").all()).toEqual([{ code: "REDACTED_SECRET" }]);
  });

  it("surfaces a tracked edit's write refusal as the original error (#88)", () => {
    const f = fixture(); createNote(f); syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    const file = join(f.mirror, state.path);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "AKIAABCDEFGHIJKLMNOP is our access key"));
    expect(() => syncMirror(f.ctx, f.mirror)).toThrow(expect.objectContaining({ code: "REDACTED_SECRET", message: "Content matched a secret detector" }));
    expect(f.db.prepare("SELECT code FROM rejections").all()).toEqual([{ code: "REDACTED_SECRET" }]);
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Original body" });
  });

  it("reconciles an untracked edit with its ref removed instead of importing a duplicate (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^ref: .*\n/m, "").replace("Original body", "Edited while stopped"));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 1, conflicts: 0 });
    expect(count(f, "entries")).toBe(1);
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Edited while stopped" });
  });

  it("keeps an unparseable untracked edit as a conflict copy (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    const broken = readFileSync(file, "utf8").replace("\n---\n", "\n").replace("Original body", "Half saved");
    writeFileSync(file, broken);
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 1 });
    expect(count(f, "entries")).toBe(1);
    expect(readFileSync(file.replace(/\.md$/, ".conflict.md"), "utf8")).toContain("Half saved");
    expect(readFileSync(file, "utf8")).toContain("Original body");
  });

  it("leaves an untracked edit in place when its conflict copy cannot be written (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    mkdirSync(file.replace(/\.md$/, ".conflict.md"));
    const edited = readFileSync(file, "utf8").replace(/^rev: .*$/m, 'rev: "1-stale"').replace("Original body", "Edited while stopped");
    writeFileSync(file, edited);
    syncMirror(f.ctx, f.mirror);
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_files").get() as { n: number }).n).toBe(0);
    rmSync(file.replace(/\.md$/, ".conflict.md"), { recursive: true });
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ conflicts: 1 });
    expect(readFileSync(file.replace(/\.md$/, ".conflict.md"), "utf8")).toContain("Edited while stopped");
  });

  it("reconciles an untracked edit saved under another letter case (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    const probe = join(f.root, "case-probe"); writeFileSync(probe, "");
    if (!existsSync(join(f.root, "CASE-PROBE"))) return; // the hazard needs a case-insensitive filesystem
    const alias = join(dirname(file), basename(file, ".md").toUpperCase() + ".md");
    const text = readFileSync(file, "utf8").replace("Original body", "Edited while stopped");
    rmSync(file); writeFileSync(alias, text);
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 1, conflicts: 0 });
    expect(count(f, "entries")).toBe(1);
    expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body: "Edited while stopped" });
    expect(readdirSync(dirname(file))).toEqual([basename(file)]);
  });

  it("never reconciles an untracked file against one of two entries sharing its path (#88)", () => {
    const f = fixture(); createNote(f); const second = createNote(f);
    const { slug } = f.db.prepare("SELECT slug FROM entries WHERE entry_id != ?").get(second.id) as { slug: string };
    f.db.prepare("UPDATE entries SET slug = ? WHERE entry_id = ?").run(slug, second.id); // an offline slug collision
    syncMirror(f.ctx, f.mirror);
    const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    f.db.prepare("DELETE FROM mirror_files").run();
    const file = join(f.mirror, state.path);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited while stopped"));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0 });
    expect(f.db.prepare("SELECT DISTINCT body FROM entries").all()).toEqual([{ body: "Original body" }]);
  });

  it("removes an untracked file whose edit archived its entry (#88)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace('status: "active"', 'status: "archived"'));
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 1, conflicts: 0 });
    expect(f.db.prepare("SELECT status FROM entries").get()).toEqual({ status: "archived" });
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(file)).toBe(false);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_files").get() as { n: number }).n).toBe(0);
  });

  function mirrorCount(f: ReturnType<typeof fixture>, table: "mirror_files" | "mirror_conflicts"): number {
    return (f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  function sealScope(f: ReturnType<typeof fixture>): void {
    const poolId = newId();
    const scopeId = (f.db.prepare("SELECT scope_id FROM scopes WHERE name = 'sample-app'").get() as { scope_id: string }).scope_id;
    f.db.prepare("INSERT INTO pools (pool_id, name, storage, sealed_file, created_at) VALUES (?, 'pool-private', 'sealed', ?, ?)").run(poolId, `sealed/${poolId}.db`, new Date().toISOString());
    f.db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, 'write')").run(poolId, scopeId);
  }

  function entryRef(f: ReturnType<typeof fixture>): string {
    return formatRef("sample-app", (f.db.prepare("SELECT entry_id FROM entries").get() as { entry_id: string }).entry_id);
  }

  it("removes an unedited untracked file of an entry archived while it was untracked (#91)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    setEntryStatus(f.ctx, entryRef(f), "archived");
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 0 });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file.replace(/\.md$/, ".conflict.md"))).toBe(false);
    expect(mirrorCount(f, "mirror_files")).toBe(0);
    expect(mirrorCount(f, "mirror_conflicts")).toBe(0);
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ written: 0, applied: 0, conflicts: 0 });
  });

  it("keeps an edit to an untracked file of an entry no longer mirrored as a conflict copy (#91)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited while stopped"));
    setEntryStatus(f.ctx, entryRef(f), "quarantined");
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 1 });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(file.replace(/\.md$/, ".conflict.md"), "utf8")).toContain("Edited while stopped");
    expect(f.db.prepare("SELECT body, status FROM entries").get()).toEqual({ body: "Original body", status: "quarantined" });
    expect(mirrorCount(f, "mirror_conflicts")).toBe(1);
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ applied: 0, conflicts: 0 });
  });

  it("deletes an edited untracked file and its conflict copy when the scope becomes sealed (#91, Spec 12.1)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Secret plaintext edit"));
    const conflict = file.replace(/\.md$/, ".conflict.md");
    writeFileSync(conflict, "Older plaintext");
    sealScope(f);
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(conflict)).toBe(false);
    expect(mirrorCount(f, "mirror_files")).toBe(0);
  });

  it("deletes an untracked sealed-scope file even with its ref edited or its frontmatter broken (#91, Spec 12.1)", () => {
    for (const edit of [(t: string) => t.replace(/ref: "[^"]+"/, 'ref: "ctxd:sample-app/01JABCDEF000000000007K2PQZ"'), (t: string) => t.replace(/\n---\n/, "\n")]) {
      const f = fixture(); const file = writtenButUntracked(f);
      writeFileSync(file, edit(readFileSync(file, "utf8")));
      sealScope(f);
      syncMirror(f.ctx, f.mirror);
      expect(existsSync(file)).toBe(false);
      expect(count(f, "entries")).toBe(1);
      expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_skips").get() as { n: number }).n).toBe(0);
    }
  });

  it("keeps a sealed-scope note whose body only mentions a ref, and removes one with an indented single-quoted ref (#91)", () => {
    const f = fixture(); createNote(f); syncMirror(f.ctx, f.mirror);
    sealScope(f);
    const note = join(f.mirror, "sample-app", "notes", "plain.md");
    const quoted = join(f.mirror, "sample-app", "notes", "quoted.md");
    writeFileSync(note, '---\nkind: "note"\n---\n# Plain\n\nref: "ctxd:sample-app/01JABCDEF000000000007K2PQZ"\n');
    writeFileSync(quoted, "---\n  ref: 'ctxd:sample-app/01JABCDEF000000000007K2PQZ'\nkind: note\n# Quoted\n\nBody\n");
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(note)).toBe(true); // a new note, refused and skipped (#72)
    expect(existsSync(quoted)).toBe(false);
  });

  it("keeps an untracked file with broken frontmatter as a conflict copy when its entry is archived (#91)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n---\n/, "\n"));
    setEntryStatus(f.ctx, entryRef(f), "archived");
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ conflicts: 1 });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file.replace(/\.md$/, ".conflict.md"))).toBe(true);
  });

  it("keeps an untracked file whose tags line was removed as a conflict copy when its entry is archived (#91)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace(/\ntags: .*\n/, "\n"));
    setEntryStatus(f.ctx, entryRef(f), "archived");
    expect(syncMirror(f.ctx, f.mirror)).toMatchObject({ conflicts: 1 });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file.replace(/\.md$/, ".conflict.md"))).toBe(true);
  });

  it("deletes an untracked file, ref'd or broken, left in a scope sealed by the real seal flow (#91, Spec 12.1)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    const second = writeEntry(f.ctx, { scope: "sample-app", kind: "note", title: "Second entry", body: "Other body", request_id: newId() } as never);
    if ("held" in second) throw new Error("unexpected held write");
    syncMirror(f.ctx, f.mirror);
    const secondPath = (f.db.prepare("SELECT path FROM mirror_files WHERE entry_id = ?").get(second.id) as { path: string }).path;
    f.db.prepare("DELETE FROM mirror_files").run();
    const broken = join(f.mirror, secondPath);
    writeFileSync(broken, readFileSync(broken, "utf8").replace(/\n---\n/, "\n")); // unclosed frontmatter
    const scopeId = (f.db.prepare("SELECT scope_id FROM scopes WHERE name = 'sample-app'").get() as { scope_id: string }).scope_id;
    const poolId = newId();
    f.db.prepare("INSERT INTO pools (pool_id, name, created_at) VALUES (?, 'pool-private', ?)").run(poolId, new Date().toISOString());
    f.db.prepare("INSERT INTO pool_grants (pool_id, scope_id, level) VALUES (?, ?, 'write')").run(poolId, scopeId);
    const sealedFile = new SealedPoolStore(f.db, f.root, new TestKeyProvider(), new TestDatabaseProvider(), 1).seal(poolId, f.ctx.nodeId);
    f.db.prepare("UPDATE pools SET storage = 'sealed', sealed_file = ? WHERE pool_id = ?").run(sealedFile, poolId); // the pool_seal ACL event
    expect(count(f, "entries")).toBe(0); // sealing erased the entries from this database
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(broken)).toBe(false);
  });

  it("deletes an untracked skill file of a purged entry rebuilt without its skill name (#91)", () => {
    const f = fixture();
    const skill = writeEntry(f.ctx, { scope: "sample-app", kind: "skill", title: "foo", body: "---\nname: foo\ndescription: Does foo things\n---\nInstructions", request_id: newId() } as never);
    if ("held" in skill) throw new Error("unexpected held write");
    syncMirror(f.ctx, f.mirror);
    const { path } = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
    f.db.prepare("DELETE FROM mirror_files").run();
    purgeEntry(f.ctx, formatRef("sample-app", skill.id), "test");
    f.db.prepare("UPDATE entries SET skill_name = NULL").run(); // as a rebuild from the purge event leaves it
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(join(f.mirror, path))).toBe(false);
  });

  it("converges after an untracked file's entry leaves the mirror, whatever the change and edit (#91, property)", () => {
    const changes = ["archived", "deleted", "superseded", "quarantined", "purged", "sealed"] as const;
    fc.assert(fc.property(fc.constantFrom(...changes), fc.boolean(), fc.nat({ max: 2 }), (change, edited, extraCycles) => {
      const f = fixture(); const file = writtenButUntracked(f);
      if (edited) writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited while stopped"));
      if (change === "purged") purgeEntry(f.ctx, entryRef(f), "test");
      else if (change === "sealed") sealScope(f);
      else f.db.prepare("UPDATE entries SET status = ?").run(change); // the status alone decides mirroring
      const events = count(f, "events");
      syncMirror(f.ctx, f.mirror);
      expect(count(f, "events")).toBe(events); // cleanup records no events
      const after = readdirSync(f.mirror, { recursive: true }).sort();
      for (let i = 0; i < extraCycles; i++) expect(syncMirror(f.ctx, f.mirror)).toEqual({ written: 0, applied: 0, conflicts: 0, archiveRequests: 0 });
      expect(readdirSync(f.mirror, { recursive: true }).sort()).toEqual(after);
      expect(existsSync(file)).toBe(false);
      const kept = edited && change !== "purged" && change !== "sealed";
      expect(existsSync(file.replace(/\.md$/, ".conflict.md"))).toBe(kept);
      expect(mirrorCount(f, "mirror_conflicts")).toBe(kept ? 1 : 0);
      expect(mirrorCount(f, "mirror_files")).toBe(0);
    }), { numRuns: 30 });
  });

  it("deletes an untracked file of a purged entry (#91)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    writeFileSync(file, readFileSync(file, "utf8").replace("Original body", "Edited while stopped"));
    purgeEntry(f.ctx, entryRef(f), "test");
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file.replace(/\.md$/, ".conflict.md"))).toBe(false);
  });

  it("leaves a copy of an inactive entry's file outside its canonical path alone (#91)", () => {
    const f = fixture(); const file = writtenButUntracked(f);
    const copy = join(dirname(file), "my-copy.md");
    writeFileSync(copy, readFileSync(file, "utf8"));
    setEntryStatus(f.ctx, entryRef(f), "archived");
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(copy)).toBe(true);
    expect(count(f, "entries")).toBe(1);
  });

  it("converges to the edited body whether or not the file was tracked before the edit (#88, property)", () => {
    fc.assert(fc.property(fc.boolean(), fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,38}[A-Za-z0-9]$/), (stopped, body) => {
      const f = fixture(); createNote(f); syncMirror(f.ctx, f.mirror);
      const state = f.db.prepare("SELECT path FROM mirror_files").get() as { path: string };
      if (stopped) f.db.prepare("DELETE FROM mirror_files").run();
      const file = join(f.mirror, state.path);
      writeFileSync(file, readFileSync(file, "utf8").replace("Original body", body));
      syncMirror(f.ctx, f.mirror);
      const afterFirst = count(f, "events");
      syncMirror(f.ctx, f.mirror);
      expect(count(f, "entries")).toBe(1);
      expect(count(f, "events")).toBe(afterFirst);
      expect(f.db.prepare("SELECT body FROM entries").get()).toEqual({ body });
      expect(readFileSync(file, "utf8")).toContain(`\n${body}\n`);
    }), { numRuns: 25 });
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
    mkdirSync(join(f.mirror, "sample-app"), { recursive: true });
    const source = join(f.mirror, "sample-app", "new-note.md");
    writeFileSync(source, "---\nkind: \"note\"\ntitle: \"Retry note\"\n---\n# Retry note\n\nBody\n");
    // A regular file where the canonical notes/ folder belongs makes mkdir (and the export) fail.
    const blocker = join(f.mirror, "sample-app", "notes");
    writeFileSync(blocker, "not a directory");
    for (let i = 0; i < 3; i++) {
      try { syncMirror(f.ctx, f.mirror); } catch { /* blocked canonical folder */ }
    }
    expect(count(f, "entries")).toBe(1);
    expect(count(f, "events")).toBe(1);
    expect(existsSync(source)).toBe(true);

    rmSync(blocker);
    syncMirror(f.ctx, f.mirror);
    expect(count(f, "entries")).toBe(1);
    expect(count(f, "events")).toBe(1);
    expect(existsSync(source)).toBe(false);
    expect(f.db.prepare("SELECT title FROM entries").get()).toEqual({ title: "Retry note" });
    syncMirror(f.ctx, f.mirror);
    expect(count(f, "entries")).toBe(1);
  });

  it("reuses the first entry when the rename itself fails once (#83)", () => {
    const f = fixture();
    const notes = join(f.mirror, "sample-app", "notes");
    mkdirSync(notes, { recursive: true });
    const source = join(f.mirror, "sample-app", "renamed.md");
    writeFileSync(source, "---\nkind: \"note\"\ntitle: \"Rename retry\"\n---\n# Rename retry\n\nBody\n");
    // A read-only notes/ folder lets mkdir succeed but makes the rename into it fail.
    chmodSync(notes, 0o555);
    try {
      try { syncMirror(f.ctx, f.mirror); } catch { /* read-only canonical folder */ }
      expect(existsSync(source)).toBe(true);
      expect(count(f, "entries")).toBe(1);
    } finally {
      chmodSync(notes, 0o755);
    }
    const [first] = f.db.prepare("SELECT entry_id FROM entries").all() as { entry_id: string }[];
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(source)).toBe(false);
    expect(f.db.prepare("SELECT entry_id FROM entries").all()).toEqual([first]);
    expect(count(f, "events")).toBe(1);
  });

  it("imports an identical file put back after a completed import as a new entry (#83)", () => {
    const f = fixture();
    const content = "---\nkind: \"note\"\ntitle: \"Again\"\n---\n# Again\n\nBody\n";
    mkdirSync(join(f.mirror, "sample-app"), { recursive: true });
    const source = join(f.mirror, "sample-app", "again.md");
    writeFileSync(source, content);
    syncMirror(f.ctx, f.mirror);
    const { entry_id: first } = f.db.prepare("SELECT entry_id FROM entries").get() as { entry_id: string };
    setEntryStatus(f.ctx, formatRef("sample-app", first), "archived");

    writeFileSync(source, content);
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(source)).toBe(false);
    const live = f.db.prepare("SELECT entry_id FROM entries WHERE status = 'active'").all() as { entry_id: string }[];
    expect(live).toHaveLength(1);
    expect(live[0]!.entry_id).not.toBe(first);
    expect(count(f, "entries")).toBe(2);
  });

  it("imports an identical file put back after a failed partial save as a new entry (#83)", () => {
    const f = fixture();
    const content = "---\nkind: \"note\"\ntitle: \"Again\"\n---\n# Again\n\nBody\n";
    mkdirSync(join(f.mirror, "sample-app"), { recursive: true });
    const source = join(f.mirror, "sample-app", "again.md");
    writeFileSync(source, content);
    syncMirror(f.ctx, f.mirror);
    writeFileSync(source, content.replace('"note"', '"not-a-kind"'));
    syncMirror(f.ctx, f.mirror);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM mirror_skips").get() as { n: number }).n).toBe(1);

    writeFileSync(source, content);
    syncMirror(f.ctx, f.mirror);
    expect(existsSync(source)).toBe(false);
    expect(count(f, "entries")).toBe(2);
  });

  it("records a skip, not a second entry, when a pending import's entry is archived (#83)", () => {
    const f = fixture();
    mkdirSync(join(f.mirror, "sample-app"), { recursive: true });
    const source = join(f.mirror, "sample-app", "pending.md");
    writeFileSync(source, "---\nkind: \"note\"\ntitle: \"Pending\"\n---\n# Pending\n\nBody\n");
    const blocker = join(f.mirror, "sample-app", "notes");
    writeFileSync(blocker, "not a directory");
    try { syncMirror(f.ctx, f.mirror); } catch { /* blocked canonical folder */ }
    const { entry_id: first } = f.db.prepare("SELECT entry_id FROM entries").get() as { entry_id: string };
    setEntryStatus(f.ctx, formatRef("sample-app", first), "archived");
    rmSync(blocker);

    syncMirror(f.ctx, f.mirror);
    syncMirror(f.ctx, f.mirror);
    expect(count(f, "entries")).toBe(1);
    expect(existsSync(source)).toBe(true);
    expect(f.db.prepare("SELECT code FROM mirror_skips").get()).toEqual({ code: "NOT_ALLOWED" });
  });

  it("converges to one entry per file however often the move fails (#83, property)", () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), (blockedCycles) => {
      const f = fixture();
      mkdirSync(join(f.mirror, "sample-app"), { recursive: true });
      const source = join(f.mirror, "sample-app", "flaky.md");
      writeFileSync(source, "---\nkind: \"note\"\ntitle: \"Flaky\"\n---\n# Flaky\n\nBody\n");
      const blocker = join(f.mirror, "sample-app", "notes");
      for (const blocked of blockedCycles) {
        if (blocked && !existsSync(blocker)) writeFileSync(blocker, "not a directory");
        if (!blocked && existsSync(blocker) && !lstatSync(blocker).isDirectory()) rmSync(blocker);
        try { syncMirror(f.ctx, f.mirror); } catch { /* blocked canonical folder */ }
        expect(count(f, "entries")).toBe(1);
      }
      if (existsSync(blocker) && !lstatSync(blocker).isDirectory()) rmSync(blocker);
      syncMirror(f.ctx, f.mirror);
      expect(count(f, "entries")).toBe(1);
      expect(count(f, "events")).toBe(1);
      expect(existsSync(source)).toBe(false);
      f.db.close();
    }), { numRuns: 40 });
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
  // FS-AC-11
  it("refuses to export an entry whose stored scope name would escape the output directory", () => {
    const f = fixture(); createNote(f);
    // A row stored before scope names were validated, or by a peer before materialize checked them.
    f.db.prepare("UPDATE scopes SET name = '../escape' WHERE name = 'sample-app'").run();
    expect(() => exportMarkdown(f.db, join(f.root, "export"))).toThrow(/escapes the mirror directory/);
    expect(existsSync(join(f.root, "escape"))).toBe(false);
  });

  // FS-AC-9
  it("refuses to write a mirror file for a slug containing ../", () => {
    const f = fixture(); createNote(f);
    f.db.prepare("UPDATE entries SET slug = '../../../escaped'").run();
    expect(() => syncMirror(f.ctx, f.mirror)).toThrow(/escapes the mirror directory/);
    expect(existsSync(join(f.root, "escaped.md"))).toBe(false);
  });

  // FS-AC-9
  it("refuses to unlink a tracked path outside the mirror directory", () => {
    const f = fixture(); const { id } = createNote(f) as { id: string };
    const victim = join(f.root, "victim.md"); writeFileSync(victim, "keep me\n");
    f.db.prepare("UPDATE entries SET status = 'deleted' WHERE entry_id = ?").run(id);
    f.db.prepare("INSERT INTO mirror_files (path, entry_id, content_rev, file_hash, written_at) VALUES ('../victim.md', ?, 'r', 'h', ?)").run(id, new Date().toISOString());
    expect(() => syncMirror(f.ctx, f.mirror)).toThrow(/escapes the mirror directory/);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  });

  // FS-AC-11
  it("refuses to write through a symlinked folder inside the output directory", () => {
    const f = fixture(); createNote(f);
    const outside = join(f.root, "outside"); mkdirSync(outside);
    const out = join(f.root, "export");
    mkdirSync(join(out, "sample-app"), { recursive: true });
    symlinkSync(outside, join(out, "sample-app", "notes"));
    expect(() => exportMarkdown(f.db, out)).toThrow(/Symbolic links are not allowed in the mirror/);
    expect(readdirSync(outside)).toEqual([]);
  });

  // FS-AC-10
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
