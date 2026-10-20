import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HlcClock } from "../../src/core/hlc.js";
import { newId } from "../../src/core/ids.js";
import { LoopbackTextModel, type TextModel } from "../../src/local-model/client.js";
import { runLocalModelSuggestions } from "../../src/local-model/suggestions.js";
import { openDatabase } from "../../src/store/db.js";
import { writeEntry, type WriteContext } from "../../src/store/write.js";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctxd-local-model-")); scratch.push(root);
  const db = openDatabase(join(root, "ctxd.db"), { create: true });
  const nodeId = newId(); const humanId = newId(); const scopeId = newId();
  db.prepare("INSERT INTO nodes (node_id, name, role, created_at) VALUES (?, 'node-a', 'home', ?)").run(nodeId, new Date().toISOString());
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'human', 'human', ?, ?, ?)").run(humanId, nodeId, newId(), new Date().toISOString());
  db.prepare("INSERT INTO scopes (scope_id, name, created_at) VALUES (?, 'sample-app', ?)").run(scopeId, new Date().toISOString());
  const ctx: WriteContext = { db, clock: new HlcClock(nodeId), nodeId, clientId: humanId, flags: new Map([["local_model", true]]) };
  const source = writeEntry(ctx, { scope: "sample-app", kind: "note", title: "A source note", body: "A detailed source body.", request_id: newId() } as never);
  if ("held" in source) throw new Error("unexpected held write");
  return { db, ctx, source };
}

describe("local model proposals", () => {
  it("writes labeled summary and lesson proposals through the normal event path", async () => {
    const f = fixture();
    const complete = vi.fn(async () => JSON.stringify({ summary: "Concise machine summary.", lesson: "Check the boundary before changing it." }));
    const model: TextModel = { modelId: "fake-model", complete };
    expect(await runLocalModelSuggestions(f.ctx, model)).toEqual({ proposed: 2, failed: 0 });
    const rows = f.db.prepare("SELECT kind, status, body, tags FROM entries WHERE entry_id != ? ORDER BY kind").all(f.source.id) as { kind: string; status: string; body: string; tags: string }[];
    expect(rows.map((row) => row.kind)).toEqual(["brief", "lesson"]);
    expect(rows.every((row) => row.status === "proposed")).toBe(true);
    expect(rows.every((row) => (JSON.parse(row.tags) as string[]).includes("machine-written"))).toBe(true);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM relations WHERE type = 'derived_from'").get() as { n: number }).n).toBe(2);
    expect(await runLocalModelSuggestions(f.ctx, model)).toEqual({ proposed: 0, failed: 0 });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("leaves deterministic content unchanged when the model fails", async () => {
    const f = fixture();
    const before = f.db.prepare("SELECT summary FROM entries WHERE entry_id = ?").get(f.source.id);
    const result = await runLocalModelSuggestions(f.ctx, { modelId: "fake-model", complete: async () => { throw new Error("offline"); } });
    expect(result).toEqual({ proposed: 0, failed: 1 });
    expect(f.db.prepare("SELECT summary FROM entries WHERE entry_id = ?").get(f.source.id)).toEqual(before);
  });

  it("rejects non-loopback model endpoints before making a request", () => {
    expect(() => new LoopbackTextModel("https://example.invalid/generate", "fake-model")).toThrow(/loopback/);
  });
});
