import type Database from "better-sqlite3";
import { revVersion } from "../core/ids.js";

/**
 * Turns one already-appended event into its effect on `entries` and `relations` (SPEC v6
 * section 6, step 7). Shared by the live write path (store/write.ts) and `ctxd rebuild`
 * (store/rebuild.ts), so the two can never materialize an event differently.
 */

export interface EventForMaterialize {
  eventId: string;
  scopeId: string;
  entryId: string;
  op: string;
  part: "content" | "status" | "relations";
  rev: string;
  clientId: string;
  hlc: string;
  payload: Record<string, unknown>;
  prev: Record<string, unknown> | null;
}

interface CreatePayload {
  kind: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  status: string;
  significance?: string | null;
  skill_name?: string | null;
  confirmed_by_user?: boolean;
  review_after?: string | null;
  supersedes?: string | null;
}

export interface ApplyEventOptions {
  /** Skip the incremental per-event FTS sync. `ctxd rebuild` sets this and does one bulk FTS5 rebuild instead. */
  skipFts?: boolean;
}

export function applyEvent(db: Database.Database, e: EventForMaterialize, { skipFts = false }: ApplyEventOptions = {}): void {
  if (e.part === "content" && e.op === "create") {
    const p = e.payload as unknown as CreatePayload;
    db.prepare(
      `INSERT INTO entries (
         entry_id, scope_id, kind, slug, significance, skill_name, title, summary, body, tags,
         content_rev, content_version, status, status_rev, relations_rev, review_after,
         confirmed_by_user, supersedes, created_by, updated_by, created_hlc, updated_hlc
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.entryId,
      e.scopeId,
      p.kind,
      p.slug,
      p.significance ?? null,
      p.skill_name ?? null,
      p.title,
      p.summary,
      p.body,
      JSON.stringify(p.tags),
      e.rev,
      p.status,
      e.rev,
      e.rev,
      p.review_after ?? null,
      p.confirmed_by_user ? 1 : 0,
      p.supersedes ?? null,
      e.clientId,
      e.clientId,
      e.hlc,
      e.hlc,
    );
    if (!skipFts) syncFtsRow(db, e.entryId, null);
    return;
  }

  if (e.part === "content" && e.op === "update") {
    const current = db.prepare("SELECT title, summary, body, tags FROM entries WHERE entry_id = ?").get(e.entryId) as
      | { title: string; summary: string; body: string; tags: string }
      | undefined;
    if (!current) throw new Error(`materialize: update for missing entry ${e.entryId}`);
    const merged = {
      title: (e.payload.title as string | undefined) ?? current.title,
      summary: (e.payload.summary as string | undefined) ?? current.summary,
      body: (e.payload.body as string | undefined) ?? current.body,
      tags: e.payload.tags !== undefined ? JSON.stringify(e.payload.tags) : current.tags,
    };
    db.prepare(
      "UPDATE entries SET title = ?, summary = ?, body = ?, tags = ?, content_rev = ?, content_version = ?, updated_by = ?, updated_hlc = ? WHERE entry_id = ?",
    ).run(merged.title, merged.summary, merged.body, merged.tags, e.rev, revVersion(e.rev), e.clientId, e.hlc, e.entryId);
    if (!skipFts) syncFtsRow(db, e.entryId, current);
    return;
  }

  if (e.part === "status" && e.op === "status") {
    const p = e.payload as { status: string };
    const prevStatus = (e.prev as { status?: string } | null)?.status ?? null;
    db.prepare("UPDATE entries SET status = ?, status_before = ?, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
      p.status,
      prevStatus,
      e.rev,
      e.hlc,
      e.entryId,
    );
    return;
  }

  if (e.part === "relations" && e.op === "relate") {
    const p = e.payload as { type: string; ref: string; note?: string | null; link_id: string };
    db.prepare("INSERT INTO relations (link_id, entry_id, type, target, note, added_event) VALUES (?, ?, ?, ?, ?, ?)").run(
      p.link_id,
      e.entryId,
      p.type,
      p.ref,
      p.note ?? null,
      e.eventId,
    );
    db.prepare("UPDATE entries SET relations_rev = ? WHERE entry_id = ?").run(e.rev, e.entryId);
    return;
  }

  throw new Error(`materialize: no handler yet for op=${e.op} part=${e.part} (lands with its own M1 slice)`);
}

/** Sync the FTS5 external-content row for an entry after it changes (SPEC v6 section 4). */
export function syncFtsRow(
  db: Database.Database,
  entryId: string,
  before: { title: string; body: string; tags: string } | null,
): void {
  const row = db.prepare("SELECT rowid, title, body, tags FROM entries WHERE entry_id = ?").get(entryId) as
    | { rowid: number; title: string; body: string; tags: string }
    | undefined;
  if (!row) return;
  if (before) {
    db.prepare("INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', ?, ?, ?, ?)").run(
      row.rowid,
      before.title,
      before.body,
      ftsTags(before.tags),
    );
  }
  db.prepare("INSERT INTO entries_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)").run(
    row.rowid,
    row.title,
    row.body,
    ftsTags(row.tags),
  );
}

/** Tags are stored as a JSON array; FTS indexes them as plain space-joined words. */
export function ftsTags(tagsJson: string): string {
  return (JSON.parse(tagsJson) as string[]).join(" ");
}
