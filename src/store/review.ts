/**
 * `ctxd review` (SPEC v6 section 13's CLI reference, 10.4's review rules, 7.4's conflict
 * policies and 7.6's drift notice): the human-only review queue, approvals and review-rule
 * management.
 *
 * `conflicted` and `auto_resolved` are both artifacts of a *concurrent* event arriving from
 * another node (SPEC 7.4's "Content of status, brief: last writer wins... listed in review as
 * 'auto-resolved'," and "Content of convention, fact, lesson, note, task: the entry moves to
 * conflicted"), populated by src/store/materialize.ts's conflict policies since M3 slice 3; a
 * single node that has never synced still sees both as empty, correctly, since it never receives
 * a concurrent event.
 *
 * Review rules (`--rules`, `--add-rule`, `--remove-rule`) read `scopes.review_policy` and write
 * it through an `acl` event (`saveRules`, M3 slice 6), the same mechanism `src/cli/grant.ts` and
 * `src/cli/pool.ts` now use for `client_grants`/`pool_grants`/`pool_members`/scope creation: SPEC
 * v6 10.4's "Rules travel through scope metadata events" closed the cross-cutting gap that used
 * to apply to all of them (SPEC v8 4; `src/store/materialize.ts`'s `applyAclEvent`).
 */
import type Database from "better-sqlite3";
import { makeRev, newId, revVersion } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { CtxdError } from "../core/errors.js";
import { KINDS } from "../core/kinds.js";
import { canonicalJson } from "./idempotency.js";
import { formatRef, parseRef } from "../model/refs.js";
import { appendAclEvent } from "./acl.js";
import { applyEvent } from "./materialize.js";
import { loadClient, loadClientName, loadScopeByName } from "./snapshot.js";
import type { WriteContext } from "./write.js";

export interface ReviewRule {
  kind: string;
  client?: string;
  confirmed_by_user?: boolean;
  action: "auto-accept";
}

export interface ReviewItem {
  ref: string;
  kind: string;
  title: string;
  created_by: string;
  at: string;
}

export interface NameClash {
  scope: string;
  kind: string;
  name: string;
  refs: string[];
}

export interface DriftNotice {
  ref: string;
  holder: string;
  drift: string[];
}

export interface Takeover {
  ref: string;
  holder: string;
  taken_over_from: string;
}

export interface RejectionSummary {
  client: string;
  scope: string | null;
  code: string;
  count: number;
}

export interface ReviewReport {
  proposed: ReviewItem[];
  conflicted: ReviewItem[];
  auto_resolved: { ref: string; at: string }[];
  name_clashes: NameClash[];
  drift: DriftNotice[];
  takeovers: Takeover[];
  rejections: RejectionSummary[];
}

function entryRef(db: Database.Database, scopeId: string, entryId: string): string {
  const scope = db.prepare("SELECT name FROM scopes WHERE scope_id = ?").get(scopeId) as { name: string };
  return formatRef(scope.name, entryId);
}

function itemsByStatus(db: Database.Database, status: string): ReviewItem[] {
  const rows = db
    .prepare(
      `SELECT e.entry_id, e.scope_id, e.kind, e.title, e.created_by, e.created_hlc
       FROM entries e WHERE e.status = ? ORDER BY e.created_hlc DESC`,
    )
    .all(status) as { entry_id: string; scope_id: string; kind: string; title: string; created_by: string; created_hlc: string }[];
  return rows.map((r) => ({
    ref: entryRef(db, r.scope_id, r.entry_id),
    kind: r.kind,
    title: r.title,
    created_by: loadClientName(db, r.created_by),
    at: r.created_hlc,
  }));
}

function autoResolved(db: Database.Database): { ref: string; at: string }[] {
  const rows = db
    .prepare(
      `SELECT es.event_id, e.entry_id, e.scope_id, ev.hlc FROM entry_siblings es
       JOIN entries e ON e.entry_id = es.entry_id
       JOIN events ev ON ev.event_id = es.event_id
       WHERE es.reason = 'lww'
       ORDER BY ev.hlc DESC`,
    )
    .all() as { entry_id: string; scope_id: string; hlc: string }[];
  return rows.map((r) => ({ ref: entryRef(db, r.scope_id, r.entry_id), at: r.hlc }));
}

/**
 * Two entries share a name when a brief, catalog or lookup would show them under the same text:
 * `title` for every kind except `skill`, whose displayed name is `skill_name` (SPEC v6 4.3). Not
 * `entries.slug`: slugify() (src/fsview/paths.ts) appends each entry's own id, so two different
 * entries can never actually share a slug; the schema's "entries created offline... may collide"
 * comment on that index predates that suffix and is itself stale, not a reason to group by it.
 */
function nameClashes(db: Database.Database): NameClash[] {
  const byTitle = db
    .prepare(
      `SELECT scope_id, kind, title AS name FROM entries
       WHERE status != 'deleted' AND kind != 'skill'
       GROUP BY scope_id, kind, title HAVING COUNT(*) > 1`,
    )
    .all() as { scope_id: string; kind: string; name: string }[];
  const bySkillName = db
    .prepare(
      `SELECT scope_id, 'skill' AS kind, skill_name AS name FROM entries
       WHERE status != 'deleted' AND kind = 'skill' AND skill_name IS NOT NULL
       GROUP BY scope_id, skill_name HAVING COUNT(*) > 1`,
    )
    .all() as { scope_id: string; kind: string; name: string }[];

  return [...byTitle, ...bySkillName].map((g) => {
    const members = (
      g.kind === "skill"
        ? db.prepare("SELECT entry_id FROM entries WHERE scope_id = ? AND kind = 'skill' AND skill_name = ? AND status != 'deleted' ORDER BY created_hlc ASC").all(g.scope_id, g.name)
        : db.prepare("SELECT entry_id FROM entries WHERE scope_id = ? AND kind = ? AND title = ? AND status != 'deleted' ORDER BY created_hlc ASC").all(g.scope_id, g.kind, g.name)
    ) as { entry_id: string }[];
    const scope = db.prepare("SELECT name FROM scopes WHERE scope_id = ?").get(g.scope_id) as { name: string };
    return { scope: scope.name, kind: g.kind, name: g.name, refs: members.map((m) => formatRef(scope.name, m.entry_id)) };
  });
}

/** Releases under a strict-intent-policy scope whose drift is non-empty (SPEC 7.5.4). */
function driftNotices(db: Database.Database): DriftNotice[] {
  const rows = db
    .prepare(
      `SELECT l.task_id, l.scope_id, l.holder, l.drift FROM leases l
       JOIN scopes s ON s.scope_id = l.scope_id
       WHERE l.state = 'released' AND l.drift IS NOT NULL AND l.drift != '[]' AND s.intent_policy = 'strict'`,
    )
    .all() as { task_id: string; scope_id: string; holder: string; drift: string }[];
  return rows.map((r) => ({ ref: entryRef(db, r.scope_id, r.task_id), holder: loadClientName(db, r.holder), drift: JSON.parse(r.drift) as string[] }));
}

function takeovers(db: Database.Database): Takeover[] {
  const rows = db
    .prepare(
      `SELECT task_id, scope_id, holder, taken_over_by FROM leases WHERE taken_over_by IS NOT NULL`,
    )
    .all() as { task_id: string; scope_id: string; holder: string; taken_over_by: string }[];
  return rows.map((r) => ({ ref: entryRef(db, r.scope_id, r.task_id), holder: loadClientName(db, r.holder), taken_over_from: loadClientName(db, r.taken_over_by) }));
}

/** Rejections in the last `days` days, grouped by client, scope and error code (SPEC v6 6.1). */
function rejectionSummary(db: Database.Database, days: number): RejectionSummary[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT client_id, scope_id, code, COUNT(*) AS n FROM rejections
       WHERE at >= ? GROUP BY client_id, scope_id, code ORDER BY n DESC`,
    )
    .all(since) as { client_id: string; scope_id: string | null; code: string; n: number }[];
  return rows.map((r) => ({
    client: loadClientName(db, r.client_id),
    scope: r.scope_id ? (db.prepare("SELECT name FROM scopes WHERE scope_id = ?").get(r.scope_id) as { name: string } | undefined)?.name ?? null : null,
    code: r.code,
    count: r.n,
  }));
}

export function buildReviewReport(db: Database.Database, rejectionWindowDays = 7): ReviewReport {
  return {
    proposed: itemsByStatus(db, "proposed"),
    conflicted: itemsByStatus(db, "conflicted"),
    auto_resolved: autoResolved(db),
    name_clashes: nameClashes(db),
    drift: driftNotices(db),
    takeovers: takeovers(db),
    rejections: rejectionSummary(db, rejectionWindowDays),
  };
}

function nextOriginSeq(db: Database.Database, nodeId: string): number {
  return (db.prepare("SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM events WHERE origin_node = ?").get(nodeId) as { next: number }).next;
}

/** `ctxd review --approve <ref>` (human only): moves a proposed or conflicted entry to active. */
export function resolveEntry(ctx: WriteContext, ref: string): { ref: string; status: string } {
  const { db } = ctx;
  const client = loadClient(db, ctx.clientId);
  if (!client) throw new CtxdError("UNAUTHORIZED", "Unknown or revoked client");
  if (client.vendor !== "human") throw new CtxdError("NOT_ALLOWED", "Review actions are human only");

  const parsed = parseRef(ref);
  const id = parsed ? parsed.id : ref;
  const row = db.prepare("SELECT entry_id, scope_id, status, status_rev FROM entries WHERE entry_id = ?").get(id) as
    | { entry_id: string; scope_id: string; status: string; status_rev: string }
    | undefined;
  if (!row) throw new CtxdError("NOT_FOUND", `Entry not found: ${ref}`, {}, "ref");
  if (row.status !== "proposed" && row.status !== "conflicted") {
    throw new CtxdError("VALIDATION", "Entry is not proposed or conflicted", {}, "ref");
  }

  const eventId = newId();
  const hlc = ctx.clock.tick();
  const rev = makeRev(revVersion(row.status_rev) + 1, eventId);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'resolve', 'status', ?, ?, ?, NULL, NULL, NULL, '{}', NULL, ?)`,
    ).run(eventId, ctx.nodeId, nextOriginSeq(db, ctx.nodeId), hlc, row.scope_id, row.entry_id, canonicalJson([row.status_rev]), rev, ctx.clientId, nowIso());
    applyEvent(db, { eventId, scopeId: row.scope_id, entryId: row.entry_id, op: "resolve", part: "status", rev, clientId: ctx.clientId, hlc, payload: {}, prev: null });
  })();

  const updated = db.prepare("SELECT status FROM entries WHERE entry_id = ?").get(row.entry_id) as { status: string };
  return { ref, status: updated.status };
}

function loadRules(db: Database.Database, scopeId: string): ReviewRule[] {
  const row = db.prepare("SELECT review_policy FROM scopes WHERE scope_id = ?").get(scopeId) as { review_policy: string };
  const parsed = JSON.parse(row.review_policy) as unknown;
  return Array.isArray(parsed) ? (parsed as ReviewRule[]) : [];
}

/** Replaces a scope's whole review policy via an `acl` event (SPEC v8 4, 10.4: "Rules travel through scope metadata events, and only the human client can create or change them"). */
function saveRules(ctx: WriteContext, scopeId: string, rules: ReviewRule[]): void {
  appendAclEvent(ctx, scopeId, { action: "scope_review_policy_set", review_policy: rules });
}

export function listRules(db: Database.Database, scopeName: string): ReviewRule[] {
  const scope = loadScopeByName(db, scopeName);
  if (!scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${scopeName}`);
  return loadRules(db, scope.id);
}

/** `ctxd review --add-rule` (human only). Narrow by construction (SPEC v6 10.4). */
export function addRule(ctx: WriteContext, scopeName: string, rule: ReviewRule): ReviewRule[] {
  const { db } = ctx;
  const client = loadClient(db, ctx.clientId);
  if (!client || client.vendor !== "human") throw new CtxdError("NOT_ALLOWED", "Review rules are human only");
  const scope = loadScopeByName(db, scopeName);
  if (!scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${scopeName}`);

  if (!KINDS.includes(rule.kind as (typeof KINDS)[number])) throw new CtxdError("VALIDATION", `kind must be one of: ${KINDS.join(", ")}`, {}, "kind");
  if (rule.kind === "skill" || rule.kind === "preference") {
    throw new CtxdError("VALIDATION", "A rule may not auto-accept kind skill or preference", {}, "kind");
  }
  if (rule.client === undefined && rule.confirmed_by_user !== true) {
    throw new CtxdError("VALIDATION", "A rule must name a client or require confirmed_by_user: true", {}, "client");
  }

  const rules = [...loadRules(db, scope.id), { ...rule, action: "auto-accept" as const }];
  saveRules(ctx, scope.id, rules);
  return rules;
}

/** `ctxd review --remove-rule` (human only), by the rule's position in `--rules`'s listing. */
export function removeRule(ctx: WriteContext, scopeName: string, index: number): ReviewRule[] {
  const { db } = ctx;
  const client = loadClient(db, ctx.clientId);
  if (!client || client.vendor !== "human") throw new CtxdError("NOT_ALLOWED", "Review rules are human only");
  const scope = loadScopeByName(db, scopeName);
  if (!scope) throw new CtxdError("NOT_FOUND", `Scope not found: ${scopeName}`);

  const rules = loadRules(db, scope.id);
  if (index < 0 || index >= rules.length) throw new CtxdError("VALIDATION", `index must be between 0 and ${rules.length - 1}`, {}, "index");
  rules.splice(index, 1);
  saveRules(ctx, scope.id, rules);
  return rules;
}
