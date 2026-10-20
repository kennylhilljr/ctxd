import type Database from "better-sqlite3";
import { HlcClock } from "../core/hlc.js";
import { newId } from "../core/ids.js";
import { appendAclEvent } from "../store/acl.js";
import { writeEntry, type WriteContext } from "../store/write.js";
import type { TextModel } from "./client.js";

interface SourceRow { entry_id: string; scope_id: string; scope_name: string; kind: string; title: string; body: string; content_rev: string }

function ensureModelClient(db: Database.Database, nodeId: string): string {
  const existing = db.prepare("SELECT client_id, vendor, revoked_at FROM clients WHERE name = 'local-model'").get() as { client_id: string; vendor: string; revoked_at: string | null } | undefined;
  if (existing) {
    if (existing.vendor !== "local" || existing.revoked_at) throw new Error("local-model client name is unavailable");
    return existing.client_id;
  }
  const id = newId();
  db.prepare("INSERT INTO clients (client_id, name, vendor, node_id, token_hash, created_at) VALUES (?, 'local-model', 'local', ?, ?, ?)")
    .run(id, nodeId, `internal:${newId()}`, new Date().toISOString());
  return id;
}

function parseOutput(text: string): { summary?: string; lesson?: string } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as { summary?: unknown; lesson?: unknown };
  return {
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : undefined,
    lesson: typeof parsed.lesson === "string" && parsed.lesson.trim() ? parsed.lesson.trim() : undefined,
  };
}

export async function runLocalModelSuggestions(humanCtx: WriteContext, model: TextModel, limit = 10): Promise<{ proposed: number; failed: number }> {
  const { db } = humanCtx;
  const modelClient = ensureModelClient(db, humanCtx.nodeId);
  const sources = db.prepare(
    `SELECT e.entry_id, e.scope_id, s.name AS scope_name, e.kind, e.title, e.body, e.content_rev
     FROM entries e JOIN scopes s ON s.scope_id = e.scope_id
     WHERE e.purged_at IS NULL AND e.status = 'active' AND e.body != '' AND e.updated_by != ?
     ORDER BY e.updated_hlc DESC LIMIT ?`,
  ).all(modelClient, limit) as SourceRow[];
  let proposed = 0; let failed = 0;
  for (const source of sources) {
    const base = `local-model:${source.entry_id}:${source.content_rev}`;
    const already = db.prepare("SELECT 1 FROM events WHERE client_id = ? AND request_id IN (?, ?) LIMIT 1").get(modelClient, `${base}:summary`, `${base}:lesson`);
    if (already) continue;
    try {
      const output = parseOutput(await model.complete(
        `Return JSON with optional string fields summary and lesson. Use only facts in this ctxd entry.\nKind: ${source.kind}\nTitle: ${source.title}\nBody:\n${source.body}`,
      ));
      if (!db.prepare("SELECT 1 FROM client_grants WHERE client_id = ? AND scope_id = ?").get(modelClient, source.scope_id)) {
        appendAclEvent(humanCtx, modelClient, { action: "client_grant", scope_id: source.scope_id, level: "propose", expires_at: "9999-12-31T23:59:59.999Z", granted_by: humanCtx.clientId });
      }
      const ctx: WriteContext = { db, clock: new HlcClock(humanCtx.nodeId), nodeId: humanCtx.nodeId, clientId: modelClient, flags: humanCtx.flags };
      const tags = ["machine-written", "local-model", `model:${model.modelId.slice(0, 80)}`];
      if (output.summary) {
        const text = output.summary.slice(0, 20_000);
        const result = writeEntry(ctx, { scope: source.scope_name, kind: "brief", title: `Machine summary: ${source.title}`.slice(0, 200), body: text, summary: text.slice(0, 200), tags: [...tags, "summary"], links: [{ type: "derived_from", ref: `ctxd:${source.scope_name}/${source.entry_id}` }], request_id: `${base}:summary` } as never);
        if (!("held" in result)) proposed++;
      }
      if (output.lesson) {
        const result = writeEntry(ctx, { scope: source.scope_name, kind: "lesson", title: `Suggested lesson: ${source.title}`.slice(0, 200), body: output.lesson.slice(0, 20_000), tags: [...tags, "lesson-suggestion"], links: [{ type: "derived_from", ref: `ctxd:${source.scope_name}/${source.entry_id}` }], request_id: `${base}:lesson` } as never);
        if (!("held" in result)) proposed++;
      }
    } catch { failed++; }
  }
  return { proposed, failed };
}
