import type Database from "better-sqlite3";
import { revVersion } from "../core/ids.js";
import { decodeHlc } from "../core/hlc.js";

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
  part: "content" | "status" | "relations" | "claim" | "meta";
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
  // Purge rewrites every OTHER stored event for the entry to {"purged": true} (SPEC 7.6.6 step
  // 2); replaying one of those neutered events (e.g. a rebuild after a purge) must not try to
  // materialize a create/update/etc with no real payload. The purge event's own payload is never
  // rewritten, so this never short-circuits the purge handler below it.
  // Fixed in SPEC-v7 (was an M1 gap): a rebuild after a purge used to leave the entry absent from
  // `entries`, since the create event that would normally insert the row is one of the neutered
  // ones. The purge handler below now UPSERTs using scope_id/kind/slug carried in its own event
  // payload, so it reconstructs the stub row whether or not the create event ran first.
  if ((e.payload as { purged?: boolean }).purged === true) return;

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
    // "Edit... also close[s] open flags with that action as the resolution" (SPEC 7.6.1).
    closeOpenFlags(db, e.entryId, "edit");
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
    // "...supersede, archive and purge also close open flags with that action as the resolution" (SPEC 7.6.1).
    if (p.status === "superseded" || p.status === "archived") closeOpenFlags(db, e.entryId, p.status === "superseded" ? "supersede" : "archive");
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

  if (e.part === "status" && e.op === "flag") {
    const p = e.payload as { flag_id: string; problem: string; reason: string };
    db.prepare("INSERT INTO flags (flag_id, entry_id, problem, reason, flagged_by, flagged_hlc, resolved) VALUES (?, ?, ?, ?, ?, ?, NULL)").run(
      p.flag_id,
      e.entryId,
      p.problem,
      p.reason,
      e.clientId,
      e.hlc,
    );
    // "An entry already flagged gets an additional flag row; its status is unchanged" (SPEC 7.6.1):
    // only the first open flag moves status to 'flagged', preserving the original status_before.
    const current = db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(e.entryId) as { status: string };
    if (current.status !== "flagged") {
      db.prepare("UPDATE entries SET status = 'flagged', status_before = ?, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
        current.status,
        e.rev,
        e.hlc,
        e.entryId,
      );
    }
    return;
  }

  if (e.part === "claim" && e.op === "claim") {
    const p = e.payload as {
      holder: string;
      paths: string[] | null;
      ttl_minutes: number;
      session_ref: string | null;
      base_head: string | null;
      taken_over_from: string | null;
    };
    const expiresAt = new Date(decodeHlc(e.hlc).physical + p.ttl_minutes * 60_000).toISOString();
    db.prepare(
      `INSERT INTO leases (task_id, scope_id, holder, state, paths, claim_event, claim_hlc, session_ref, base_head, expires_at, last_activity_hlc, tentative, taken_over_by)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (task_id) DO UPDATE SET
         scope_id = excluded.scope_id, holder = excluded.holder, state = 'active', paths = excluded.paths,
         claim_event = excluded.claim_event, claim_hlc = excluded.claim_hlc, session_ref = excluded.session_ref,
         base_head = excluded.base_head, expires_at = excluded.expires_at, last_activity_hlc = excluded.last_activity_hlc,
         released_at = NULL, changed_files = NULL, drift = NULL, lost_by = NULL, taken_over_by = excluded.taken_over_by`,
    ).run(
      e.entryId,
      e.scopeId,
      p.holder,
      p.paths !== null ? JSON.stringify(p.paths) : null,
      e.eventId,
      e.hlc,
      p.session_ref,
      p.base_head,
      expiresAt,
      e.hlc,
      p.taken_over_from,
    );
    return;
  }

  if (e.part === "claim" && e.op === "release") {
    const p = e.payload as { changed_files: string[] | null; drift: string[] | null };
    db.prepare(
      "UPDATE leases SET state = 'released', released_at = ?, changed_files = ?, drift = ?, last_activity_hlc = ? WHERE task_id = ?",
    ).run(
      new Date(decodeHlc(e.hlc).physical).toISOString(),
      p.changed_files !== null ? JSON.stringify(p.changed_files) : null,
      p.drift !== null ? JSON.stringify(p.drift) : null,
      e.hlc,
      e.entryId,
    );
    return;
  }

  if (e.part === "status" && e.op === "unflag") {
    const current = db.prepare("SELECT status_before FROM entries WHERE entry_id = ?").get(e.entryId) as { status_before: string | null };
    // status_before should always be set once an entry is flagged; the fallback only guards
    // against replaying a malformed or hand-crafted event, never a real unflag of a live entry.
    const restored = current.status_before ?? "active";
    db.prepare("UPDATE entries SET status = ?, status_before = NULL, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(
      restored,
      e.rev,
      e.hlc,
      e.entryId,
    );
    closeOpenFlags(db, e.entryId, "unflagged");
    return;
  }

  if (e.part === "status" && e.op === "resolve") {
    // `ctxd review --approve` (SPEC 7.4's "a resolve event... clears it", for both a proposed
    // entry awaiting review and, once M3's sync lands, a conflicted one): always lands on
    // 'active'. Unlike unflag, there is no status_before to restore from.
    db.prepare("UPDATE entries SET status = 'active', status_before = NULL, status_rev = ?, updated_hlc = ? WHERE entry_id = ?").run(e.rev, e.hlc, e.entryId);
    return;
  }

  if (e.part === "meta" && e.op === "purge") {
    const payload = e.payload as { fingerprint: string; scope_id: string; kind: string; slug: string };
    const before = db.prepare("SELECT rowid, title, body, tags FROM entries WHERE entry_id = ?").get(e.entryId) as
      | { rowid: number; title: string; body: string; tags: string }
      | undefined;
    // UPSERT, not a plain UPDATE (SPEC v7 7.6.6): a rebuild replays the create event neutered to
    // {"purged": true} (the guard at the top of this function), so the row may not exist yet when
    // this purge event itself is replayed. scope_id/kind/slug come from the purge event's own
    // payload (recorded at purge time in store/purge.ts); the other NOT NULL columns get inert
    // placeholders derived from the purge event (content_rev/status_rev/relations_rev from its
    // rev, created/updated by/hlc from its client and hlc, status 'archived'), since a purged
    // entry's status and revisions are never meaningfully read again (get.ts and fts.ts both key
    // off purged_at, never status, to detect a purged entry).
    // The ON CONFLICT branch sets every one of those placeholder columns too, not just the
    // content fields: convergence (SPEC 7.3) requires a purged entry to materialize identically
    // whether this event finds the row already live (the normal write path) or reconstructs it
    // from nothing (a rebuild), so a purge must fully normalize the row either way rather than
    // leave live-only fields (status, content_rev, created_hlc, ...) at their pre-purge values.
    db.prepare(
      `INSERT INTO entries (
         entry_id, scope_id, kind, slug, title, summary, body, tags,
         content_rev, content_version, status, status_rev, relations_rev,
         purged_at, purge_fingerprint, created_by, updated_by, created_hlc, updated_hlc
       ) VALUES (?, ?, ?, ?, '[purged]', '', '', '[]', ?, 1, 'archived', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entry_id) DO UPDATE SET
         title = '[purged]', summary = '', body = '', tags = '[]',
         content_rev = excluded.content_rev, content_version = excluded.content_version,
         status = excluded.status, status_rev = excluded.status_rev, relations_rev = excluded.relations_rev,
         purged_at = excluded.purged_at, purge_fingerprint = excluded.purge_fingerprint,
         created_by = excluded.created_by, updated_by = excluded.updated_by,
         created_hlc = excluded.created_hlc, updated_hlc = excluded.updated_hlc`,
    ).run(
      e.entryId,
      payload.scope_id,
      payload.kind,
      payload.slug,
      e.rev,
      e.rev,
      e.rev,
      e.hlc,
      payload.fingerprint,
      e.clientId,
      e.clientId,
      e.hlc,
      e.hlc,
    );
    // entries_fts is an external-content table: a plain DELETE does nothing (and can corrupt the
    // index); it needs the 'delete' command with the row's prior values, same as syncFtsRow.
    if (!skipFts && before) {
      db.prepare("INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', ?, ?, ?, ?)").run(
        before.rowid,
        before.title,
        before.body,
        ftsTags(before.tags),
      );
    }
    db.prepare("DELETE FROM relations WHERE entry_id = ?").run(e.entryId);
    db.prepare("UPDATE relations SET target = '[purged]' WHERE target LIKE ?").run(`%/${e.entryId}`);
    closeOpenFlags(db, e.entryId, "purge");
    // "Erase history": every stored event for this entry is rewritten in place (the only
    // operation that rewrites events, ADR-0002's own carve-out) -- but not this purge event
    // itself, whose own payload is exactly what records the fingerprint that blocks reinsertion.
    db.prepare("UPDATE events SET payload = '{\"purged\":true}', prev = NULL WHERE entry_id = ? AND event_id != ?").run(e.entryId, e.eventId);
    return;
  }

  throw new Error(`materialize: no handler yet for op=${e.op} part=${e.part} (lands with its own M1 slice)`);
}

/** Close every open flag on an entry with the given resolution (SPEC v6 section 7.6.1). */
function closeOpenFlags(db: Database.Database, entryId: string, resolution: string): void {
  db.prepare("UPDATE flags SET resolved = ? WHERE entry_id = ? AND resolved IS NULL").run(resolution, entryId);
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
