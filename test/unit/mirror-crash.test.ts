import * as realFs from "node:fs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { openDatabase } from "../../src/store/db.js";
import type { WriteContext } from "../../src/store/write.js";
import { syncMirror } from "../../src/mirror/markdown.js";

/**
 * Simulates ctxd stopping in the middle of a mirror import (#85). Every filesystem mutation the mirror
 * makes goes through this hook; at the chosen step it snapshots the database and the mirror folder, as a
 * process killed at that instant would leave them. The test then "restarts" from the snapshot.
 */
const crash = vi.hoisted(() => ({ hook: undefined as undefined | (() => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const wrap = <F extends (...args: never[]) => unknown>(fn: F) => ((...args: Parameters<F>) => {
    crash.hook?.();
    const out = fn(...args);
    crash.hook?.();
    return out;
  }) as F;
  const mocked = { ...fs, writeFileSync: wrap(fs.writeFileSync), renameSync: wrap(fs.renameSync), unlinkSync: wrap(fs.unlinkSync), mkdirSync: wrap(fs.mkdirSync) };
  return { ...mocked, default: mocked };
});

const scratch: string[] = [];
afterEach(() => {
  crash.hook = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(dbPath: string, nodeId: string, clientId: string, create = false): WriteContext {
  const db = openDatabase(dbPath, { create });
  return { db, clock: new HlcClock(nodeId), nodeId, clientId, flags: new Map([["mirror", true]]) };
}

function count(ctx: WriteContext, table: "entries" | "events" | "mirror_files" | "mirror_conflicts" | "archive_requests"): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Runs one import, stopping at mutation step `stopAt`, and returns the restarted state. */
function importStoppedAt(stopAt: number, title: string, body: string) {
  const root = mkdtempSync(join(tmpdir(), "ctxd-mirror-crash-")); scratch.push(root);
  const mirror = join(root, "mirror");
  const nodeId = newId(); const clientId = newId();
  const ctx = context(join(root, "ctxd.db"), nodeId, clientId, true);
  ctx.db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'node-a', 'home', ?)").run(nodeId, new Date().toISOString());
  ctx.db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(clientId, nodeId, newId(), new Date().toISOString());
  ctx.db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(newId(), new Date().toISOString());
  mkdirSync(join(mirror, "sample-app"), { recursive: true });
  const source = join(mirror, "sample-app", "new-note.md");
  writeFileSync(source, `---\nkind: "note"\ntitle: ${JSON.stringify(title)}\n---\n# ${title}\n\n${body}\n`);

  const snapshot = join(root, "snapshot");
  let step = 0;
  let stopped = false;
  crash.hook = () => {
    if (stopped || step++ !== stopAt) return;
    stopped = true;
    mkdirSync(snapshot);
    realFs.writeFileSync(join(snapshot, "ctxd.db"), ctx.db.serialize());
    cpSync(mirror, join(snapshot, "mirror"), { recursive: true });
  };
  syncMirror(ctx, mirror);
  crash.hook = undefined;
  ctx.db.close();
  if (!stopped) return { stopped, ctx: undefined, mirror, source };
  // Restart from what the stopped process left behind.
  rmSync(mirror, { recursive: true });
  cpSync(join(snapshot, "mirror"), mirror, { recursive: true });
  return { stopped, ctx: context(join(snapshot, "ctxd.db"), nodeId, clientId), mirror, source };
}

function files(dir: string): string[] {
  return (realFs.readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".md")).map((name) => relative(dir, join(dir, name))).sort();
}

function expectConverged(ctx: WriteContext, mirror: string, source: string): void {
  for (let i = 0; i < 2; i++) syncMirror(ctx, mirror);
  expect(count(ctx, "entries")).toBe(1);
  expect(count(ctx, "events")).toBe(1);
  expect(count(ctx, "mirror_conflicts")).toBe(0);
  expect(count(ctx, "archive_requests")).toBe(0);
  expect(existsSync(source)).toBe(false);
  const { entry_id: id } = ctx.db.prepare("SELECT entry_id FROM entries").get() as { entry_id: string };
  const tracked = ctx.db.prepare("SELECT path, entry_id, file_hash FROM mirror_files").all() as { path: string; entry_id: string; file_hash: string }[];
  expect(tracked).toHaveLength(1);
  expect(tracked[0]!.entry_id).toBe(id);
  expect(files(mirror)).toEqual([tracked[0]!.path]);
  const text = readFileSync(join(mirror, tracked[0]!.path), "utf8");
  expect(text).toContain(`ref: "ctxd:sample-app/${id}"`);
  expect(createHash("sha256").update(text).digest("hex")).toBe(tracked[0]!.file_hash);
}

describe("mirror import survives a stop at any step (#85, Spec 12.1)", () => {
  it("never imports a new file twice, wherever ctxd stops during its first cycle", () => {
    let steps = 0;
    for (; ; steps++) {
      const run = importStoppedAt(steps, "Stopped note", "Body");
      if (!run.stopped) break;
      expectConverged(run.ctx!, run.mirror, run.source);
      run.ctx!.db.close();
    }
    expect(steps).toBeGreaterThan(4); // the import and the export each made several mutations
  });

  it("converges to one entry for any note and any stop point (#85, property)", () => {
    const text = fc.string({ minLength: 1, maxLength: 40 }).map((s) => s.replace(/[\r\n#-]/g, "").trim()).filter((s) => s.length > 0);
    fc.assert(fc.property(fc.nat({ max: 12 }), text, text, (stopAt, title, body) => {
      const run = importStoppedAt(stopAt, title, `${body}​`); // zero-width space: the sanitizer changes the body
      if (!run.stopped) return;
      expectConverged(run.ctx!, run.mirror, run.source);
      run.ctx!.db.close();
    }), { numRuns: 40 });
  });
});
