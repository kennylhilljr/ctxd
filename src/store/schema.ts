/**
 * Database schema (SPEC v8 section 4). Keep in sync with the spec.
 * The event log is the source of truth; everything else is materialized. Sealed pools use the same schema in their own encrypted file (SPEC v7 10.6).
 * Bumped to 8 for M3 slice 2 (replication, Spec 7.1): the new `peers` table replaces the unused
 * `nodes.peer_token_hash` placeholder, since peers are never rows in `nodes` (that table's many
 * `SELECT node_id FROM nodes LIMIT 1` call sites assume exactly one row: the local node).
 * Bumped to 9 for M3 slice 3 (conflict policies, Spec 7.4): a new `events(entry_id, rev)` index
 * backs the conflict lookup `eventHoldingRev` (src/store/materialize.ts) added that slice.
 * Bumped to 10 for M3 slice 5 (claims across nodes, Spec 7.4, 7.5): `entry_siblings.part`'s CHECK
 * now allows `'claim'`, so a claim event that loses a concurrent-claim race can be recorded the
 * same way a losing content/status event already is; `peers.last_synced_at` records when a pull
 * from that peer last completed successfully, backing the "no successful sync for 10 minutes"
 * tentative-claim check (src/store/claim.ts).
 * Bumped to 11 for M3 slice 6 (ACL and scope metadata as events, Spec v8 4): `scopes.kind`'s
 * CHECK now allows `'system'`, for the reserved `_system` scope `acl` events travel in; the new
 * `acl_cursors` table backs an HLC guard (found during `/simplify`) so a grant and a revoke of
 * the same pool/scope applied out of causal order converge on whichever is actually later,
 * instead of letting a stale grant silently un-revoke what a later revoke already took away.
 * Bumped to 12 for M3 slice 7 (sync freshness and the N-node partition property suite, Spec
 * 7.1-7.4): `events.materialized` marks a stored event that `src/sync/apply.ts`'s `decide`
 * deferred as missing-parent (per-origin pull batching does not guarantee cross-origin causal
 * delivery order), retried once a sibling event for the same entry materializes
 * (`retryPendingFor`); `leases.earliest_claim_hlc` tracks a task's smallest claim_hlc across every
 * epoch, so a late-arriving concurrent claim is always resolved against the task's true earliest
 * claimant, not whichever claim happens to be current right now.
 * Bumped to 13 for M5 slice 8 (semantic search, Spec 11.2.1): `events.part`'s CHECK now allows
 * `'embedding'`; the new `embeddings` table materializes embedding vectors, current content
 * only (like FTS), keyed by (entry_id, model_id) so a different model's vector is kept alongside
 * rather than overwritten.
 * Bumped to 14 for M6 slice 1 (signed events, Spec v9 section 7.7): immutable payload hashes,
 * Ed25519 signatures, and trusted per-origin public keys survive purge and verify on replay.
 * Bumped to 15 for M6 slice 2: mirror conflicts and deletion archive requests are local review
 * records. Successful edits and imports still travel through ordinary events.
 * Bumped to 16 for M6 slice 3: sealed purge work may wait for its pool key.
 * Bumped to 17 for M6 hardening: signatures cover the immutable envelope and separate retained
 * payload hashes; peer records bind authenticated tokens to remote node identities and keys.
 * Bumped to 18: payload_stripped is trusted stored state for verified purge erasure.
 * Bumped to 20 for W5 slice 2: `sessions.cwd`, recorded at SessionStart and kept for that
 * session's lifetime, so the crash sweep can run the same mechanical release and journal entry a
 * real SessionEnd runs, for a session that crashed and never got there (SPEC 9.10).
 * Bumped to 21 for W2: `node_encryption_keys` holds each node's long-lived signed X25519
 * encryption prekey; `sealed_key_transfers` tracks the state of an authenticated sealed pool key
 * transfer to a newly enrolled node, from request through one-time-use fetch.
 */
export const SCHEMA_VERSION = 21;

export const SCHEMA_SQL = `
CREATE TABLE nodes (
  node_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('home','roaming')),
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE node_origin_sequences (
  node_id TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL
);

CREATE TABLE node_keys (
  node_id      TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_signed_seq INTEGER NOT NULL
);

CREATE TABLE peers (                   -- a machine we sync with (Spec 7.1); never a row in nodes
  peer_id             TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  url                 TEXT NOT NULL,     -- e.g. https://laptop.TAILNET.ts.net/ctxd-sync
  role                TEXT NOT NULL CHECK (role IN ('home','roaming')), -- the peer's own role, for the 7.2 filter when it pulls from us
  incoming_token_hash TEXT NOT NULL,     -- hash of the token this peer must present to pull from us
  outgoing_token      TEXT,              -- the token we present when pulling from this peer; NULL until supplied
  revoked_at          TEXT,
  created_at          TEXT NOT NULL,
  last_synced_at      TEXT                -- set when a pull from this peer last completed successfully (Spec 7.4's tentative-claim check)
  ,remote_node_id     TEXT
  ,remote_public_key  TEXT
);

CREATE TABLE clients (
  client_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  vendor       TEXT NOT NULL CHECK (vendor IN ('anthropic','openai','google','local','human','other')),
  tags         TEXT NOT NULL DEFAULT '[]', -- JSON array; pool membership may be by tag
  node_id      TEXT NOT NULL REFERENCES nodes(node_id),
  token_hash   TEXT NOT NULL UNIQUE,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE scopes (
  scope_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project','me','profile','hold','system')),
  owner         TEXT,                  -- pool_id for kind 'profile'; client_id for kind 'hold'
  description   TEXT NOT NULL DEFAULT '',
  replication   TEXT NOT NULL DEFAULT 'all' CHECK (replication IN ('all','home','local')),
  vendor_policy TEXT NOT NULL DEFAULT 'any' CHECK (vendor_policy IN ('any','local-only')),
  review_policy TEXT NOT NULL DEFAULT '[]',
  intent_policy TEXT NOT NULL DEFAULT 'warn' CHECK (intent_policy IN ('observe','warn','strict')),
  created_at    TEXT NOT NULL
);

CREATE TABLE events (
  event_id     TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  origin_node  TEXT NOT NULL,
  origin_seq   INTEGER NOT NULL,
  hlc          TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  entry_id     TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('create','update','status','delete','resolve','claim','release','relate','unrelate','flag','unflag','quarantine','unquarantine','revert','purge','acl','suspend','resume')),
  part         TEXT NOT NULL CHECK (part IN ('content','status','relations','claim','meta','embedding')),
  parent_revs  TEXT NOT NULL DEFAULT '[]',
  rev          TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  session_ref  TEXT,
  request_id   TEXT,
  request_hash TEXT,                 -- SHA-256 of the canonical request input, for idempotency checks
  payload      TEXT NOT NULL,
  prev         TEXT,                   -- JSON: prior values of the changed fields of this part (NULL on create)
  payload_hash TEXT,                   -- SHA-256 of canonical payload and prev; retained by purge
  prev_hash    TEXT,                   -- SHA-256 of canonical prior values; retained by purge
  signature    TEXT,                   -- base64 Ed25519 signature over payload_hash; NULL for unsigned legacy events
  public_key   TEXT,                   -- base64 SPKI key, pinned in node_keys on first verified event
  payload_stripped INTEGER NOT NULL DEFAULT 0,
  received_at  TEXT NOT NULL,
  materialized INTEGER NOT NULL DEFAULT 1, -- 0: stored but deferred, sync/apply.ts's "missing-parent"
                                            -- row (its own create, or an earlier rev, hasn't arrived
                                            -- yet); retried once a sibling event for the same entry
                                            -- materializes (its own real apply, every local write and
                                            -- rebuild, always sets this to 1 up front)
  UNIQUE (origin_node, origin_seq),
  UNIQUE (client_id, request_id)
);
CREATE INDEX events_entry ON events(entry_id, hlc);
CREATE INDEX events_entry_rev ON events(entry_id, rev);  -- the conflict-policy lookup, eventHoldingRev (Spec 7.4)

CREATE TABLE entries (
  entry_id     TEXT PRIMARY KEY,
  scope_id     TEXT NOT NULL REFERENCES scopes(scope_id),
  kind         TEXT NOT NULL CHECK (kind IN ('brief','status','decision','convention','fact','lesson','handoff','task','pointer','note','preference','skill','journal')),
  slug         TEXT NOT NULL,          -- path slug, fixed at create (4.2)
  significance TEXT CHECK (significance IN ('routine','milestone','breakthrough','blocker','incident','decision')), -- journal only
  skill_name   TEXT,                   -- skill only; equals the SKILL.md name (4.3)
  -- content part
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,          -- one line, at most 200 characters; agent-written or first sentence of body
  body         TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  content_rev  TEXT NOT NULL,
  content_version INTEGER NOT NULL,
  -- status part
  status       TEXT NOT NULL CHECK (status IN ('active','proposed','flagged','quarantined','superseded','archived','conflicted','deleted')),
  status_before TEXT,                  -- status to restore on unflag or release
  review_after TEXT,                   -- ISO date; NULL = never
  purged_at    TEXT,                   -- non-NULL: content erased (7.6.6)
  purge_fingerprint TEXT,              -- SHA-256 of the erased content, to block re-insertion
  status_rev   TEXT NOT NULL,
  approved_by  TEXT,
  approved_hlc TEXT,
  -- relations part (rows live in the relations table)
  relations_rev TEXT NOT NULL,
  supersedes   TEXT,                   -- denormalized from relations for fast lookups
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  created_hlc  TEXT NOT NULL,
  updated_hlc  TEXT NOT NULL
);
CREATE INDEX entries_scope_kind ON entries(scope_id, kind, status, updated_hlc);
CREATE INDEX entries_slug ON entries(scope_id, kind, slug);      -- not unique: entries created offline on two nodes may collide (4.2)
CREATE INDEX entries_skill ON entries(scope_id, skill_name) WHERE skill_name IS NOT NULL; -- not unique: name clashes are resolved on read (4.3)
CREATE INDEX entries_journal ON entries(scope_id, created_hlc) WHERE kind = 'journal';

CREATE TABLE entry_siblings (
  entry_id     TEXT NOT NULL,
  part         TEXT NOT NULL CHECK (part IN ('content','status','relations','claim')),
  rev          TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  PRIMARY KEY (entry_id, part, rev)
);

CREATE TABLE relations (
  link_id      TEXT PRIMARY KEY,       -- ULID of the add event's link; identity for add-wins merge
  entry_id     TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('supersedes','implements','derived_from','blocks','relates_to','points_to','caused','resolved')),
  target       TEXT NOT NULL,          -- ctxd reference, or for points_to: file:, commit:, url:
  note         TEXT,
  added_event  TEXT NOT NULL,
  removed_event TEXT                   -- NULL while present
);
CREATE INDEX relations_entry ON relations(entry_id) WHERE removed_event IS NULL;
CREATE INDEX relations_target ON relations(target, type) WHERE removed_event IS NULL;

CREATE TABLE pools (
  pool_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,   -- e.g. pool-dev; "all" is reserved
  description  TEXT NOT NULL DEFAULT '',
  defaults     TEXT NOT NULL DEFAULT '{}', -- JSON: replication, vendor_policy, review_policy, intent_policy for new scopes
  storage      TEXT NOT NULL DEFAULT 'shared' CHECK (storage IN ('shared','sealed')),
  sealed_file  TEXT,                   -- for sealed pools: file name derived from pool_id, never from the name
  created_at   TEXT NOT NULL
);

CREATE TABLE pool_grants (
  pool_id      TEXT NOT NULL REFERENCES pools(pool_id),
  scope_id     TEXT NOT NULL REFERENCES scopes(scope_id),
  level        TEXT NOT NULL CHECK (level IN ('read','propose','write')),
  PRIMARY KEY (pool_id, scope_id)
);

CREATE TABLE pool_members (
  pool_id      TEXT NOT NULL REFERENCES pools(pool_id),
  principal    TEXT NOT NULL,          -- "client:<client_id>" or "tag:<tag>"
  PRIMARY KEY (pool_id, principal)
);

CREATE TABLE persona_tokens (
  token_hash   TEXT PRIMARY KEY,       -- SHA-256 of the token; the secret lives only in the issuing machine's Keychain
  client_id    TEXT NOT NULL,
  pools        TEXT NOT NULL,          -- JSON sorted array of pool ids; '[]' means the _me-only token
  node_id      TEXT NOT NULL,          -- machine whose Keychain holds the secret
  created_at   TEXT NOT NULL,
  rotated_from TEXT,
  revoked_at   TEXT
);
CREATE INDEX persona_tokens_client ON persona_tokens(client_id);

CREATE TABLE persona_prefs (           -- resolves ambiguity when several of a client's pools grant a scope
  client_id    TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  pool_id      TEXT NOT NULL,
  PRIMARY KEY (client_id, scope_id)
);

CREATE TABLE pool_enrollments (        -- machines allowed to hold a sealed pool
  pool_id      TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  enrolled_at  TEXT NOT NULL,
  PRIMARY KEY (pool_id, node_id)
);

CREATE TABLE node_encryption_keys (    -- W2: each node's long-lived X25519 prekey, signed by its own Ed25519 identity (node_keys)
  node_id      TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL,          -- base64 SPKI
  signature    TEXT NOT NULL,          -- base64 Ed25519 signature over node_id||public_key, by this node's own node_keys identity
  created_at   TEXT NOT NULL
);

CREATE TABLE sealed_key_transfers (    -- W2: one authenticated sealed pool key transfer, request through one-time-use fetch
  transfer_id       TEXT PRIMARY KEY,
  pool_id           TEXT NOT NULL,
  requester_node_id TEXT NOT NULL,     -- the new node asking to be enrolled
  source_node_id    TEXT NOT NULL,     -- the node currently holding the key, approving
  status            TEXT NOT NULL CHECK (status IN ('pending','approved','fetched','refused')),
  wrapped_key       TEXT,              -- CiphertextEnvelope JSON, set on approval; null until then
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  approved_at       TEXT,
  fetched_at        TEXT               -- set exactly once, at the first successful fetch (replay protection)
);

CREATE TABLE sealed_purge_queue (
  pool_id      TEXT NOT NULL,
  entry_id     TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (pool_id, entry_id)
);

CREATE TABLE client_grants (           -- temporary grants
  client_id    TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('read','propose','write')),
  expires_at   TEXT NOT NULL,
  granted_by   TEXT NOT NULL,          -- always the human client
  PRIMARY KEY (client_id, scope_id)
);

-- HLC guard for acl events (Spec v8 4, M3 slice 6): one row per mutable access-metadata target
-- (a pool+scope grant, a pool+principal membership, a client+scope grant, a scope's review
-- policy), so a grant and a revoke of the same target applied out of causal order converge on
-- whichever carries the later HLC, not on arrival order (src/store/materialize.ts's
-- applyAclEvent). target is a free-form composite key, not a foreign key to any one table,
-- since it names whichever table's row the acl action actually touches.
CREATE TABLE acl_cursors (
  target       TEXT PRIMARY KEY,
  updated_hlc  TEXT NOT NULL
);

CREATE TABLE access_requests (
  request_id   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  pool_ids     TEXT NOT NULL,          -- JSON: pools that contain the scope
  held_entries TEXT NOT NULL DEFAULT '[]', -- JSON: references of entries held in the client's holding scope
  attempts     INTEGER NOT NULL DEFAULT 1,
  first_at     TEXT NOT NULL,
  last_at      TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('open','allowed_entry','granted','added_to_pool','denied')),
  decided_at   TEXT,
  UNIQUE (client_id, scope_id, state)
);

CREATE TABLE flags (
  flag_id      TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL,
  problem      TEXT NOT NULL CHECK (problem IN ('wrong','stale','duplicate','unsafe')),
  reason       TEXT NOT NULL,          -- sanitized, at most 300 characters
  flagged_by   TEXT NOT NULL,
  flagged_hlc  TEXT NOT NULL,
  resolved     TEXT                    -- NULL while open; resolution action when closed
);

CREATE TABLE batches (                 -- quarantine and rollback batches
  batch_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('quarantine','rollback')),
  selector     TEXT NOT NULL,          -- JSON: client, session, since, until, scope
  state        TEXT NOT NULL CHECK (state IN ('open','reverted','released','partial')),
  created_by   TEXT NOT NULL,
  created_hlc  TEXT NOT NULL
);

CREATE TABLE batch_members (
  batch_id     TEXT NOT NULL REFERENCES batches(batch_id),
  entry_id     TEXT NOT NULL,
  first_event  TEXT NOT NULL,          -- earliest selected event for the entry
  created_in_batch INTEGER NOT NULL,   -- 1 if the entry was created inside the window
  outcome      TEXT,                   -- reverted, released, conflict
  PRIMARY KEY (batch_id, entry_id)
);

CREATE TABLE read_stats (              -- local only, never replicated
  entry_id     TEXT PRIMARY KEY,
  last_read_at TEXT NOT NULL,
  reads        INTEGER NOT NULL DEFAULT 0, -- context_get fetches and CLI reads
  briefed      INTEGER NOT NULL DEFAULT 0  -- inclusions in briefs
);

CREATE TABLE signals (                 -- materialized from entries, relations and flags (11.4)
  entry_id     TEXT NOT NULL,          -- the blocker or incident journal entry, blocking task, or flagged entry
  scope_id     TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('journal','task','flag')),
  opened_hlc   TEXT NOT NULL,
  resolved_hlc TEXT,                   -- NULL while open
  resolved_by  TEXT,                   -- reference of the resolving entry, or retired, unblocked or flag
  PRIMARY KEY (entry_id, source)       -- a flagged blocker has both a journal row and a flag row
);
CREATE INDEX signals_open ON signals(scope_id) WHERE resolved_hlc IS NULL;

CREATE TABLE skill_syncs (             -- local only: files written by native skill sync (12.2)
  client       TEXT NOT NULL,          -- client adapter id, e.g. claude-code
  skill_entry  TEXT NOT NULL,
  path         TEXT NOT NULL,          -- absolute path of the written SKILL.md
  content_hash TEXT NOT NULL,          -- SHA-256 of what ctxd wrote; a different hash on disk means a local edit
  synced_at    TEXT NOT NULL,
  PRIMARY KEY (client, skill_entry)
);

CREATE TABLE mirror_files (            -- local only: Markdown mirror state (12.1)
  path         TEXT PRIMARY KEY,       -- relative to the mirror directory
  entry_id     TEXT NOT NULL,
  content_rev  TEXT NOT NULL,          -- revision the file was written from
  file_hash    TEXT NOT NULL,
  written_at   TEXT NOT NULL
);

CREATE TABLE mirror_conflicts (
  path         TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL,
  file_rev     TEXT,
  current_rev  TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE archive_requests (
  entry_id     TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE tool_metrics (            -- local only: response metering (8.5)
  at           TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  tool         TEXT NOT NULL,          -- MCP tool, or "hook:<event>" for injected briefs
  scope_id     TEXT,
  chars        INTEGER NOT NULL,
  est_tokens   INTEGER NOT NULL,
  truncated    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tool_metrics_at ON tool_metrics(at);

CREATE TABLE scope_repos (
  repo         TEXT PRIMARY KEY,       -- normalized origin, e.g. github.com/kennylhilljr/ctxd
  scope_id     TEXT NOT NULL REFERENCES scopes(scope_id)
);

CREATE TABLE rejections (                -- local only, never replicated, metadata only (no content)
  rejection_id TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  scope_id     TEXT,
  entry_id     TEXT,
  tool         TEXT NOT NULL,
  code         TEXT NOT NULL,          -- error code, e.g. REV_CONFLICT, REDACTED_SECRET
  detail       TEXT,                   -- detector names or rev numbers only; never submitted text
  at           TEXT NOT NULL
);

CREATE TABLE leases (
  task_id      TEXT PRIMARY KEY,
  scope_id     TEXT NOT NULL,
  holder       TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active','released','expired','taken_over','lost')),
  paths        TEXT,                 -- JSON array of normalized patterns; NULL = unknown, '[]' = no writes
  claim_event  TEXT NOT NULL,
  claim_hlc    TEXT NOT NULL,
  earliest_claim_hlc TEXT NOT NULL, -- the smallest claim_hlc this task has EVER contended (7.4): a
                                     -- late-arriving concurrent claim from a closed-and-reclaimed
                                     -- epoch is still compared against this, not the current
                                     -- (possibly much later) claim_hlc, so "earliest wins" holds
                                     -- regardless of delivery order even across a release/reclaim
  session_ref  TEXT,
  base_head    TEXT,                 -- git HEAD when claimed, for the drift audit
  expires_at   TEXT NOT NULL,
  last_activity_hlc TEXT NOT NULL,
  tentative    INTEGER NOT NULL DEFAULT 0,
  released_at  TEXT,
  changed_files TEXT,                -- JSON array, recorded on release
  drift        TEXT,                 -- JSON array of changed files outside paths
  taken_over_by TEXT,
  lost_by      TEXT,
  suspended_at TEXT                  -- non-NULL: quarantine suspended this claim (7.6.2); overlaps and blocking ignore it
);
CREATE INDEX leases_scope_state ON leases(scope_id, state);

CREATE TABLE claim_overlaps (
  task_id      TEXT NOT NULL,
  other_task_id TEXT NOT NULL,
  detected_hlc TEXT NOT NULL,
  patterns     TEXT NOT NULL,        -- JSON: the overlapping pattern pairs (bounded)
  policy       TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('claim','sync')),
  PRIMARY KEY (task_id, other_task_id)
);

CREATE TABLE sessions (
  session_ref  TEXT PRIMARY KEY,      -- "<client>:<client session id>"
  client_id    TEXT NOT NULL,
  scope_id     TEXT,
  state        TEXT NOT NULL CHECK (state IN ('active','compacting','idle','ended')),
  started_at   TEXT NOT NULL,
  last_seen_hlc TEXT NOT NULL,
  head         TEXT,                  -- latest observed git HEAD
  cwd          TEXT,                  -- recorded at SessionStart, kept for the session's life (9.10's crash sweep)
  recovery     TEXT,                  -- JSON: {task_id?, phase, last_request_summary}; no transcript content
  ended_by     TEXT                   -- NULL for a real client end hook; 'sweep' when the crash sweep finalized it (9.10)
);
CREATE INDEX sessions_client_state ON sessions(client_id, state);

CREATE TABLE sync_state (
  peer_node    TEXT NOT NULL,
  origin_node  TEXT NOT NULL,
  through_seq  INTEGER NOT NULL,
  PRIMARY KEY (peer_node, origin_node)
);

CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, body, tags, content='entries', content_rowid='rowid'
);

CREATE TABLE embeddings (               -- materialized from 'embedding' events (M5, 11.2.1); current content only, like FTS
  entry_id     TEXT NOT NULL,
  model_id     TEXT NOT NULL,           -- e.g. "Xenova/all-MiniLM-L6-v2@q8"
  dim          INTEGER NOT NULL,
  vector       TEXT NOT NULL,           -- JSON array of floats; sqlite-vec reads this into its own virtual table at query time
  rev          TEXT NOT NULL,           -- the content rev this embedding was computed from
  updated_hlc  TEXT NOT NULL,
  PRIMARY KEY (entry_id, model_id)
);

CREATE TABLE commits (                 -- local facts recorded by the PostToolUse hook (SPEC v7 7.5)
  sha          TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  session_ref  TEXT,
  subject      TEXT NOT NULL,
  changed_files TEXT NOT NULL,         -- JSON array of paths
  client_id    TEXT NOT NULL,
  at           TEXT NOT NULL,
  PRIMARY KEY (sha, scope_id)
);
`;
