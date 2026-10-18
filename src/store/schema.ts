/**
 * Database schema (SPEC v3 section 4). Keep in sync with the spec.
 * The event log is the source of truth; entries, relations, siblings, leases, overlaps, sessions and FTS are materialized.
 */
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE nodes (
  node_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('home','roaming')),
  peer_token_hash TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE clients (
  client_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  vendor       TEXT NOT NULL CHECK (vendor IN ('anthropic','openai','google','local','human','other')),
  access       TEXT NOT NULL DEFAULT 'write' CHECK (access IN ('read','write')),
  node_id      TEXT NOT NULL REFERENCES nodes(node_id),
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '["*"]',
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE scopes (
  scope_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  replication   TEXT NOT NULL DEFAULT 'all' CHECK (replication IN ('all','home','local')),
  vendor_policy TEXT NOT NULL DEFAULT 'any' CHECK (vendor_policy IN ('any','local-only')),
  review_policy TEXT NOT NULL DEFAULT '{}',
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
  op           TEXT NOT NULL CHECK (op IN ('create','update','status','delete','resolve','claim','release','relate','unrelate')),
  part         TEXT NOT NULL CHECK (part IN ('content','status','relations','claim','meta')),
  parent_revs  TEXT NOT NULL DEFAULT '[]',
  rev          TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  session_ref  TEXT,
  request_id   TEXT,
  request_hash TEXT,                 -- SHA-256 of the canonical request input, for idempotency checks
  payload      TEXT NOT NULL,
  prev         TEXT,                   -- JSON: prior values of the changed fields of this part (NULL on create)
  received_at  TEXT NOT NULL,
  UNIQUE (origin_node, origin_seq),
  UNIQUE (client_id, request_id)
);
CREATE INDEX events_entry ON events(entry_id, hlc);

CREATE TABLE entries (
  entry_id     TEXT PRIMARY KEY,
  scope_id     TEXT NOT NULL REFERENCES scopes(scope_id),
  kind         TEXT NOT NULL CHECK (kind IN ('brief','status','decision','convention','fact','lesson','handoff','task','pointer','note')),
  -- content part
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,          -- one line, at most 200 characters; agent-written or first sentence of body
  body         TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  content_rev  TEXT NOT NULL,
  content_version INTEGER NOT NULL,
  -- status part
  status       TEXT NOT NULL CHECK (status IN ('active','proposed','superseded','archived','conflicted','deleted')),
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

CREATE TABLE entry_siblings (
  entry_id     TEXT NOT NULL,
  part         TEXT NOT NULL CHECK (part IN ('content','status','relations')),
  rev          TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  PRIMARY KEY (entry_id, part, rev)
);

CREATE TABLE relations (
  link_id      TEXT PRIMARY KEY,       -- ULID of the add event's link; identity for add-wins merge
  entry_id     TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('supersedes','implements','derived_from','blocks','relates_to','points_to')),
  target       TEXT NOT NULL,          -- ctxd reference, or for points_to: file:, commit:, url:
  note         TEXT,
  added_event  TEXT NOT NULL,
  removed_event TEXT                   -- NULL while present
);
CREATE INDEX relations_entry ON relations(entry_id) WHERE removed_event IS NULL;
CREATE INDEX relations_target ON relations(target, type) WHERE removed_event IS NULL;

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
  session_ref  TEXT,
  base_head    TEXT,                 -- git HEAD when claimed, for the drift audit
  expires_at   TEXT NOT NULL,
  last_activity_hlc TEXT NOT NULL,
  tentative    INTEGER NOT NULL DEFAULT 0,
  released_at  TEXT,
  changed_files TEXT,                -- JSON array, recorded on release
  drift        TEXT,                 -- JSON array of changed files outside paths
  taken_over_by TEXT,
  lost_by      TEXT
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
  recovery     TEXT                   -- JSON: {task_id?, phase, last_request_summary}; no transcript content
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
`;
