import type Database from "better-sqlite3";
import type { z } from "zod";
import type { contextWriteInput } from "../tools/schemas.js";
import { accessLevel, atLeast, decideWrite, effectiveVendorPolicy, type ClientInfo } from "../access/level.js";
import { makeRev, newId, revVersion } from "../core/ids.js";
import type { HlcClock } from "../core/hlc.js";
import { nowIso } from "../core/time.js";
import { ALWAYS_REVIEWED_KINDS, defaultAgentStatus, IMMUTABLE_KINDS, type Kind, type Status } from "../core/kinds.js";
import { isFlagOn } from "../config/flags.js";
import { CtxdError } from "../core/errors.js";
import { sanitizeAgentText } from "../security/redact.js";
import { parseSkill } from "../skills/skillmd.js";
import { slugify } from "../fsview/paths.js";
import { formatRef, parseRef } from "../model/refs.js";
import { canonicalJson, requestHash } from "./idempotency.js";
import { applyEvent } from "./materialize.js";
import { loadAccessSnapshot, loadClient, loadClientName, loadScopeByName, loadScopeById } from "./snapshot.js";
import { syncSignalsForScope } from "../journal/sync.js";

/**
 * The single write path (SPEC v6 section 6): auth, idempotency, validation, redaction,
 * optimistic concurrency, review policy, append event, materialize.
 */

export interface WriteContext {
  db: Database.Database;
  clock: HlcClock;
  nodeId: string;
  clientId: string;
  /** The session persona's pools; undefined = every pool the client belongs to (no persona yet). */
  assumedPools?: readonly string[];
  /** Effective feature flags (PRD-feature-flags-v1); undefined only in call sites predating M3, where every flag behaves as on. */
  flags?: Map<string, boolean>;
}

export type WriteResult =
  | { id: string; ref: string; rev: string; status: string }
  | { held: true; held_in: string; access_request: string; ref: string; message: string };

type Input = z.infer<typeof contextWriteInput>;

function nextOriginSeq(db: Database.Database, nodeId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM events WHERE origin_node = ?").get(nodeId) as {
    next: number;
  };
  return row.next;
}

function recordRejection(
  db: Database.Database,
  args: { clientId: string; scopeId?: string; entryId?: string; tool: string; code: string; detail?: string },
): void {
  db.prepare(
    "INSERT INTO rejections (rejection_id, client_id, scope_id, entry_id, tool, code, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(newId(), args.clientId, args.scopeId ?? null, args.entryId ?? null, args.tool, args.code, args.detail ?? null, nowIso());
}

/** Reject with `err`, first recording a metadata-only rejection row (SPEC v6 section 6). */
function reject(db: Database.Database, clientId: string, scopeId: string | undefined, entryId: string | undefined, err: CtxdError): never {
  recordRejection(db, { clientId, scopeId, entryId, tool: "context_write", code: err.code, detail: err.hint });
  throw err;
}

/** First sentence of `body`, cut to 200 characters at a word boundary (SPEC v6 section 4 field notes). */
function deriveSummary(body: string): string {
  const firstSentence = /^[^.!?\n]{1,200}[.!?]?/.exec(body.trim())?.[0]?.trim() ?? body.trim();
  if (firstSentence.length <= 200) return firstSentence;
  const cut = firstSentence.slice(0, 199);
  const sp = cut.lastIndexOf(" ");
  return `${sp > 100 ? cut.slice(0, sp) : cut}…`;
}

/** Sanitize a field, collecting detector names on failure instead of throwing immediately. */
function sanitizeField(text: string, failures: Set<string>): string {
  const r = sanitizeAgentText(text);
  if (r.ok) return r.text;
  for (const d of r.detectors) failures.add(d);
  return text;
}

export function writeEntry(ctx: WriteContext, input: Input): WriteResult {
  const { db } = ctx;
  const scope = loadScopeByName(db, input.scope);
  if (!scope) reject(db, ctx.clientId, undefined, undefined, new CtxdError("NOT_FOUND", `Scope not found: ${input.scope}`));

  const client = loadClient(db, ctx.clientId);
  if (!client) reject(db, ctx.clientId, scope.id, undefined, new CtxdError("UNAUTHORIZED", "Unknown or revoked client"));

  const snapshot = loadAccessSnapshot(db);
  const level = accessLevel(client, scope, snapshot, Date.now(), ctx.assumedPools);
  const vendorBlocked = effectiveVendorPolicy(scope, snapshot) === "local-only" && client.vendor !== "local";
  const decision = decideWrite(level, vendorBlocked);

  if (decision.kind === "forbidden") {
    reject(db, ctx.clientId, scope.id, undefined, new CtxdError("SCOPE_FORBIDDEN", `No access to scope: ${scope.name}`));
  }

  // Step 2: idempotency. Runs before the hold/direct branch (matching the spec's own step
  // order) so a retried held write replays once, rather than re-bumping access_requests.
  const hash = requestHash({ ...input, request_id: undefined });
  const existingEvent = db
    .prepare("SELECT entry_id, scope_id, request_hash FROM events WHERE client_id = ? AND request_id = ?")
    .get(ctx.clientId, input.request_id) as { entry_id: string; scope_id: string; request_hash: string } | undefined;
  if (existingEvent) {
    if (existingEvent.request_hash !== hash) {
      reject(
        db,
        ctx.clientId,
        scope.id,
        existingEvent.entry_id,
        new CtxdError("IDEMPOTENCY_MISMATCH", "request_id was already used with different input"),
      );
    }
    return replayResult(db, ctx.clientId, existingEvent.entry_id, existingEvent.scope_id);
  }

  if (decision.kind === "hold") {
    if (input.id) {
      reject(
        db,
        ctx.clientId,
        scope.id,
        input.id,
        new CtxdError("NOT_ALLOWED", "Cannot update an entry in a scope you cannot write to"),
      );
    }
    return performHeldWrite(ctx, client, scope, input, hash);
  }

  return performDirectWrite(ctx, client, scope, input, decision.kind === "propose", hash);
}

/** Reconstruct the response for a retried request_id without writing anything again. */
function replayResult(db: Database.Database, clientId: string, entryId: string, scopeId: string): WriteResult {
  const entry = db.prepare("SELECT content_rev, status FROM entries WHERE entry_id = ?").get(entryId) as
    | { content_rev: string; status: string }
    | undefined;
  if (!entry) throw new CtxdError("NOT_FOUND", "The entry from a prior identical request no longer exists");
  const scope = loadScopeById(db, scopeId);
  if (!scope) throw new CtxdError("NOT_FOUND", "The scope from a prior identical request no longer exists");

  if (scope.kind === "hold" && scope.owner === clientId) {
    const ref = formatRef(scope.name, entryId);
    const escapedRef = ref.replace(/[\\%_]/g, "\\$&");
    const request = db
      .prepare("SELECT request_id, scope_id FROM access_requests WHERE client_id = ? AND held_entries LIKE ? ESCAPE '\\'")
      .get(clientId, `%"${escapedRef}"%`) as { request_id: string; scope_id: string } | undefined;
    const target = request ? loadScopeById(db, request.scope_id) : null;
    return {
      held: true,
      held_in: scope.name,
      access_request: request?.request_id ?? "",
      ref,
      message: `This write needs the user's permission${target ? ` (scope "${target.name}" is outside your persona)` : ""}. It was held in ${scope.name}.`,
    };
  }
  return { id: entryId, ref: formatRef(scope.name, entryId), rev: entry.content_rev, status: entry.status };
}

function performDirectWrite(
  ctx: WriteContext,
  client: ClientInfo,
  scope: { id: string; name: string },
  input: Input,
  forceProposed: boolean,
  hash: string,
): WriteResult {
  const { db } = ctx;

  let existing: { entry_id: string; kind: Kind; content_rev: string; status: Status } | null = null;
  if (input.id) {
    if (!input.expected_rev) {
      reject(db, ctx.clientId, scope.id, input.id, new CtxdError("VALIDATION", "expected_rev is required with id", {}, "expected_rev"));
    }
    const row = db
      .prepare("SELECT entry_id, kind, content_rev, status, scope_id FROM entries WHERE entry_id = ?")
      .get(input.id) as { entry_id: string; kind: Kind; content_rev: string; status: Status; scope_id: string } | undefined;
    if (!row || row.scope_id !== scope.id) {
      reject(db, ctx.clientId, scope.id, input.id, new CtxdError("NOT_FOUND", `Entry not found: ${input.id}`));
    }
    if (row.kind !== input.kind) {
      reject(db, ctx.clientId, scope.id, input.id, new CtxdError("VALIDATION", "kind cannot change on update", {}, "kind"));
    }
    if (IMMUTABLE_KINDS.has(row.kind)) {
      reject(db, ctx.clientId, scope.id, input.id, new CtxdError("IMMUTABLE_KIND", `${row.kind} entries cannot be updated`));
    }
    existing = row;
  }

  // Body is required except for journal (SPEC v6 section 6 step 3) -- only on create: an update
  // that omits body means "leave it unchanged", not "clear it".
  if (!existing && input.kind !== "journal" && input.body === undefined) {
    reject(db, ctx.clientId, scope.id, input.id, new CtxdError("VALIDATION", "body is required except for journal", {}, "body"));
  }
  let skillName: string | undefined;
  if (input.kind === "skill" && input.body !== undefined) {
    skillName = parseSkill(input.title, input.body).name;
  }

  const failures = new Set<string>();
  const title = sanitizeField(input.title, failures);
  // undefined means "not provided": an update leaves that field unchanged rather than clearing it.
  const bodySan = input.body !== undefined ? sanitizeField(input.body, failures) : undefined;
  const tagsSan = input.tags !== undefined ? input.tags.map((t) => sanitizeField(t, failures)) : undefined;
  const summarySan =
    input.summary !== undefined
      ? sanitizeField(input.summary, failures)
      : bodySan !== undefined
        ? sanitizeField(deriveSummary(bodySan), failures)
        : undefined;
  const links = (input.links ?? []).map((l) => ({ ...l, note: l.note !== undefined ? sanitizeField(l.note, failures) : undefined }));
  if (failures.size > 0) {
    reject(db, ctx.clientId, scope.id, input.id, new CtxdError("REDACTED_SECRET", "Content matched a secret detector", { detectors: [...failures] }));
  }

  // "Block reinsertion" (SPEC v6 section 7.6.6 step 4): a create whose content fingerprint
  // matches a recorded purge is refused, so purged content can't simply be written back.
  if (!existing) {
    const fingerprint = requestHash({ title, body: bodySan ?? "" });
    if (db.prepare("SELECT 1 FROM entries WHERE purge_fingerprint = ?").get(fingerprint)) {
      reject(db, ctx.clientId, scope.id, input.id, new CtxdError("VALIDATION", "This content was purged", {}, "body"));
    }
  }

  if (existing && input.expected_rev !== existing.content_rev) {
    recordRejection(db, { clientId: ctx.clientId, scopeId: scope.id, entryId: existing.entry_id, tool: "context_write", code: "REV_CONFLICT" });
    throw new CtxdError("REV_CONFLICT", "Entry changed since you read it", { current_rev: existing.content_rev }, "expected_rev");
  }

  // The human-client override takes precedence over the agent-only "always reviewed" rule
  // (ALWAYS_REVIEWED_KINDS and the access-forced "propose" are both agent-specific restrictions;
  // SPEC v6 section 6 step 6's table lists "written by the human client (CLI): active" above
  // the per-kind defaults it otherwise governs).
  let status: Status;
  if (existing) {
    status = existing.status; // a content update never changes status.
  } else if (client.vendor === "human") {
    status = "active";
  } else if (forceProposed || ALWAYS_REVIEWED_KINDS.has(input.kind)) {
    status = "proposed";
  } else {
    // review.remembered_rules off (PRD-feature-flags-v1 section 4): every rule is ignored, so
    // everything proposed waits for review instead of auto-accepting.
    const rememberedRules = isFlagOn(ctx.flags, "review.remembered_rules");
    status = (rememberedRules ? reviewedStatus(db, scope.id, input, loadClientName(db, client.id)) : null) ?? defaultAgentStatus(input.kind, input.significance);
  }

  const result = db.transaction(() => {
    const allocSeq = seqAllocator(db, ctx.nodeId);
    const touchedScopes = new Set<string>([scope.id]);
    let entryId: string;
    let contentRev: string;

    if (existing) {
      entryId = existing.entry_id;
      const eventId = newId();
      const hlc = ctx.clock.tick();
      contentRev = makeRev(revVersion(existing.content_rev) + 1, eventId);
      const payload: Record<string, unknown> = { title };
      // "prev... prior values of the changed fields of this part" (schema.ts): recorded so a
      // later revert (SPEC 7.6.3) can restore exactly what this update is about to overwrite,
      // without guessing at it from some other event.
      const beforeUpdate = db.prepare("SELECT title, summary, body, tags FROM entries WHERE entry_id = ?").get(entryId) as {
        title: string;
        summary: string;
        body: string;
        tags: string;
      };
      const prev: Record<string, unknown> = { title: beforeUpdate.title };
      if (bodySan !== undefined) {
        payload.body = bodySan;
        prev.body = beforeUpdate.body;
      }
      if (summarySan !== undefined) {
        payload.summary = summarySan;
        prev.summary = beforeUpdate.summary;
      }
      if (tagsSan !== undefined) {
        payload.tags = tagsSan;
        prev.tags = JSON.parse(beforeUpdate.tags);
      }
      appendPrimaryEvent(db, ctx, input, hash, allocSeq, { scopeId: scope.id, entryId, op: "update", part: "content", rev: contentRev, parentRevs: [existing.content_rev], payload, prev, eventId, hlc });
      applyEvent(db, { eventId, scopeId: scope.id, entryId, op: "update", part: "content", rev: contentRev, clientId: ctx.clientId, hlc, payload, prev });
    } else {
      entryId = newId();
      const eventId = newId();
      const hlc = ctx.clock.tick();
      contentRev = makeRev(1, eventId);
      const slug = slugify(title, entryId, input.kind);

      let supersedesTarget: ReturnType<typeof resolveEntry> = null;
      if (input.supersedes) {
        supersedesTarget = resolveEntry(db, input.supersedes);
        if (!supersedesTarget || supersedesTarget.kind !== input.kind) {
          throw new CtxdError("VALIDATION", "supersedes target not found or a different kind", {}, "supersedes");
        }
        if (supersedesTarget.status === "superseded") {
          throw new CtxdError("VALIDATION", "supersedes target is already superseded by another entry", {}, "supersedes");
        }
        // Access is default deny (AGENTS.md): resolving an entry by id bypasses the normal
        // scope lookup, so superseding it must not become a way to write into a scope this
        // client was never granted (even read) access to.
        const targetScopeInfo = loadScopeById(db, supersedesTarget.scopeId);
        const targetLevel = targetScopeInfo ? accessLevel(client, targetScopeInfo, loadAccessSnapshot(db), Date.now(), ctx.assumedPools) : "none";
        if (!atLeast(targetLevel, "propose")) {
          throw new CtxdError("SCOPE_FORBIDDEN", "Cannot supersede an entry outside your access", {}, "supersedes");
        }
      }
      const payload: Record<string, unknown> = {
        kind: input.kind,
        slug,
        title,
        body: bodySan ?? "",
        summary: summarySan ?? title,
        tags: tagsSan ?? [],
        status,
        significance: input.significance ?? null,
        confirmed_by_user: input.confirmed_by_user ?? false,
        supersedes: supersedesTarget ? formatRef(supersedesTarget.scopeName, supersedesTarget.id) : null,
        skill_name: skillName ?? null,
      };
      appendPrimaryEvent(db, ctx, input, hash, allocSeq, { scopeId: scope.id, entryId, op: "create", part: "content", rev: contentRev, parentRevs: [], payload, eventId, hlc });
      applyEvent(db, { eventId, scopeId: scope.id, entryId, op: "create", part: "content", rev: contentRev, clientId: ctx.clientId, hlc, payload, prev: null });

      if (supersedesTarget) markSuperseded(db, ctx, supersedesTarget, allocSeq, touchedScopes);
      for (const link of links) addRelation(db, ctx, scope.id, entryId, link, allocSeq, touchedScopes);
    }

    for (const scopeId of touchedScopes) syncSignalsForScope(db, scopeId);
    return { entryId, contentRev, finalStatus: existing ? existing.status : status };
  })();

  return { id: result.entryId, ref: formatRef(scope.name, result.entryId), rev: result.contentRev, status: result.finalStatus };
}

/** Marks the superseded entry via its own status event (the new entry's `supersedes` column is set from its own create payload). */
function markSuperseded(db: Database.Database, ctx: WriteContext, target: NonNullable<ReturnType<typeof resolveEntry>>, allocSeq: () => number, touchedScopes: Set<string>): void {
  const eventId = newId();
  const hlc = ctx.clock.tick();
  const rev = makeRev(revVersion(target.statusRev) + 1, eventId);
  const payload = { status: "superseded" };
  const prev = { status: target.status };
  appendSideEvent(db, ctx, allocSeq, { scopeId: target.scopeId, entryId: target.id, op: "status", part: "status", rev, parentRevs: [target.statusRev], payload, prev, eventId, hlc });
  applyEvent(db, { eventId, scopeId: target.scopeId, entryId: target.id, op: "status", part: "status", rev, clientId: ctx.clientId, hlc, payload, prev });
  touchedScopes.add(target.scopeId);
}

function addRelation(
  db: Database.Database,
  ctx: WriteContext,
  scopeId: string,
  entryId: string,
  link: { type: string; ref: string; note?: string },
  allocSeq: () => number,
  touchedScopes: Set<string>,
): void {
  const eventId = newId();
  const hlc = ctx.clock.tick();
  // Each relate event bumps relations_rev from whatever it currently is, so multiple links on
  // one entry (several addRelation calls in a row) don't all collide on version 1.
  const current = db.prepare("SELECT relations_rev FROM entries WHERE entry_id = ?").get(entryId) as { relations_rev: string };
  const rev = makeRev(revVersion(current.relations_rev) + 1, eventId);
  const linkId = newId();
  const payload = { type: link.type, ref: link.ref, note: link.note ?? null, link_id: linkId };
  appendSideEvent(db, ctx, allocSeq, { scopeId, entryId, op: "relate", part: "relations", rev, parentRevs: [], payload, prev: null, eventId, hlc });
  applyEvent(db, { eventId, scopeId, entryId, op: "relate", part: "relations", rev, clientId: ctx.clientId, hlc, payload, prev: null });
  const linkTarget = parseRef(link.ref);
  if (linkTarget?.scope) {
    const ts = loadScopeByName(db, linkTarget.scope);
    if (ts) touchedScopes.add(ts.id);
  }
}

interface ReviewRule {
  kind: string;
  client?: string;
  confirmed_by_user?: boolean;
  action: "auto-accept";
}

/** Review-policy rules (SPEC v6 section 10.4): null means "no matching rule", fall back to defaults. */
function reviewedStatus(db: Database.Database, scopeId: string, input: Input, clientName: string): Status | null {
  const row = db.prepare("SELECT review_policy FROM scopes WHERE scope_id = ?").get(scopeId) as { review_policy: string };
  // scopes.review_policy defaults to '{}' in the schema even though SPEC v6 10.4 describes it
  // as a JSON list of rules (flagged for SPEC-v7); treat anything that isn't an array as "no
  // rules yet" rather than crashing.
  const parsed = JSON.parse(row.review_policy) as unknown;
  const rules = Array.isArray(parsed) ? (parsed as ReviewRule[]) : [];
  const matches = rules.some(
    (r) =>
      r.action === "auto-accept" &&
      r.kind === input.kind &&
      (r.client === undefined || r.client === clientName) &&
      (r.confirmed_by_user !== true || input.confirmed_by_user === true),
  );
  return matches ? "active" : null;
}

function resolveEntry(
  db: Database.Database,
  ref: string,
): { id: string; kind: Kind; status: Status; statusRev: string; scopeId: string; scopeName: string } | null {
  const parsed = parseRef(ref);
  const id = parsed ? parsed.id : ref;
  const row = db.prepare("SELECT entry_id, kind, status, status_rev, scope_id FROM entries WHERE entry_id = ?").get(id) as
    | { entry_id: string; kind: Kind; status: Status; status_rev: string; scope_id: string }
    | undefined;
  if (!row) return null;
  const scope = loadScopeById(db, row.scope_id);
  if (!scope) return null;
  return { id: row.entry_id, kind: row.kind, status: row.status, statusRev: row.status_rev, scopeId: row.scope_id, scopeName: scope.name };
}

interface EventSpec {
  scopeId: string;
  entryId: string;
  op: string;
  part: string;
  rev: string;
  parentRevs: string[];
  payload: Record<string, unknown>;
  prev?: Record<string, unknown> | null;
  eventId: string;
  hlc: string;
}

/** Allocates origin_seq once per transaction instead of re-querying MAX(origin_seq) per event. */
function seqAllocator(db: Database.Database, nodeId: string): () => number {
  let next = nextOriginSeq(db, nodeId);
  return () => next++;
}

/**
 * The one event per write that carries the client's request_id/session (idempotency, SPEC v6
 * section 6 step 2). `hash` is computed once by writeEntry, from the caller's original input,
 * and threaded through explicitly: a held write's holding-scope write must store the same hash
 * the top-level idempotency check will recompute on retry, not one recomputed from whatever
 * `input` a given call site happens to hold.
 */
function appendPrimaryEvent(db: Database.Database, ctx: WriteContext, input: Input, hash: string, allocSeq: () => number, spec: EventSpec): void {
  insertEvent(db, ctx, spec, input.session ?? null, input.request_id, hash, allocSeq);
}

/** A secondary event from the same write (a supersede side-effect or a link): no request_id of its own. */
function appendSideEvent(db: Database.Database, ctx: WriteContext, allocSeq: () => number, spec: EventSpec): void {
  insertEvent(db, ctx, spec, null, null, null, allocSeq);
}

function insertEvent(
  db: Database.Database,
  ctx: WriteContext,
  spec: EventSpec,
  sessionRef: string | null,
  requestId: string | null | undefined,
  reqHash: string | null,
  allocSeq: () => number,
): void {
  db.prepare(
    `INSERT INTO events (event_id, origin_node, origin_seq, hlc, scope_id, entry_id, op, part, parent_revs, rev, client_id, session_ref, request_id, request_hash, payload, prev, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    spec.eventId,
    ctx.nodeId,
    allocSeq(),
    spec.hlc,
    spec.scopeId,
    spec.entryId,
    spec.op,
    spec.part,
    canonicalJson(spec.parentRevs),
    spec.rev,
    ctx.clientId,
    sessionRef,
    requestId ?? null,
    reqHash,
    canonicalJson(spec.payload),
    spec.prev ? canonicalJson(spec.prev) : null,
    nowIso(),
  );
}

function performHeldWrite(
  ctx: WriteContext,
  client: ClientInfo,
  targetScope: { id: string; name: string },
  input: Input,
  hash: string,
): WriteResult {
  const { db } = ctx;
  const holdingName = `_hold.${loadClientName(db, client.id)}`;

  const result = db.transaction(() => {
    let holding = loadScopeByName(db, holdingName);
    if (!holding) {
      const holdingId = newId();
      db.prepare(
        "INSERT INTO scopes (scope_id, name, kind, owner, replication, vendor_policy, created_at) VALUES (?, ?, 'hold', ?, 'home', 'any', ?)",
      ).run(holdingId, holdingName, client.id, nowIso());
      holding = loadScopeByName(db, holdingName)!;
    }

    // performDirectWrite directly, not the recursive writeEntry: the access decision and the
    // idempotency check (whether this is fresh) were already made by the caller, and input.scope
    // is unused by performDirectWrite (it writes into the `holding` scope object given here), so
    // there is no need to rebuild `input` with a substituted scope just to pass it back through.
    const heldWrite = performDirectWrite(ctx, client, holding, input, true, hash);
    if ("held" in heldWrite) throw new Error("unreachable: performDirectWrite never returns a held result");

    const poolIds = (db.prepare("SELECT pool_id FROM pool_grants WHERE scope_id = ?").all(targetScope.id) as { pool_id: string }[]).map(
      (r) => r.pool_id,
    );

    // An access_requests row opens unconditionally (SPEC v7 section 6 step 1), even when the
    // target scope belongs to no pool: pool_ids is then the JSON empty array '[]'. This fixes an
    // M1 gap where a pool-less scope's held writes had no reviewable path at all; `ctxd review`
    // (a later M2 slice) needs to find these rows regardless of whether pool_ids is empty.
    let requestId: string;
    const openRequest = db
      .prepare("SELECT request_id, held_entries FROM access_requests WHERE client_id = ? AND scope_id = ? AND state = 'open'")
      .get(client.id, targetScope.id) as { request_id: string; held_entries: string } | undefined;
    if (openRequest) {
      const entries = JSON.parse(openRequest.held_entries) as string[];
      entries.push(heldWrite.ref);
      db.prepare("UPDATE access_requests SET attempts = attempts + 1, last_at = ?, held_entries = ? WHERE request_id = ?").run(
        nowIso(),
        JSON.stringify(entries),
        openRequest.request_id,
      );
      requestId = openRequest.request_id;
    } else {
      requestId = newId();
      db.prepare(
        "INSERT INTO access_requests (request_id, client_id, scope_id, pool_ids, held_entries, attempts, first_at, last_at, state) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'open')",
      ).run(requestId, client.id, targetScope.id, JSON.stringify(poolIds), JSON.stringify([heldWrite.ref]), nowIso(), nowIso());
    }

    return { heldWrite, requestId };
  })();

  return {
    held: true,
    held_in: holdingName,
    access_request: result.requestId,
    ref: result.heldWrite.ref,
    message: `This write needs the user's permission (scope "${targetScope.name}" is outside your persona). It was held in ${holdingName}.`,
  };
}
