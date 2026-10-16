/**
 * Database schema (SPEC section 4). Keep in sync with the spec.
 * The event log is the source of truth; entries, siblings, leases and FTS are materialized.
 */
export const SCHEMA_VERSION = 1;

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
  created_at    TEXT NOT NULL
);

CREATE TABLE events (
  event_id     TEXT PRIMARY KEY,
  origin_node  TEXT NOT NULL,
  origin_seq   INTEGER NOT NULL,
  hlc          TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  entry_id     TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('create','update','status','delete','resolve','claim','release')),
  parent_revs  TEXT NOT NULL DEFAULT '[]',
  rev          TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  session_ref  TEXT,
  request_id   TEXT,
  payload      TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  UNIQUE (origin_node, origin_seq),
  UNIQUE (client_id, request_id)
);
CREATE INDEX events_entry ON events(entry_id, hlc);

CREATE TABLE entries (
  entry_id     TEXT PRIMARY KEY,
  scope_id     TEXT NOT NULL REFERENCES scopes(scope_id),
  kind         TEXT NOT NULL CHECK (kind IN ('brief','status','decision','convention','fact','handoff','task','pointer','note')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  links        TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL CHECK (status IN ('active','proposed','superseded','archived','conflicted','deleted')),
  rev          TEXT NOT NULL,
  version      INTEGER NOT NULL,
  supersedes   TEXT,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  created_hlc  TEXT NOT NULL,
  updated_hlc  TEXT NOT NULL
);
CREATE INDEX entries_scope_kind ON entries(scope_id, kind, status, updated_hlc);

CREATE TABLE entry_siblings (
  entry_id     TEXT NOT NULL,
  rev          TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  PRIMARY KEY (entry_id, rev)
);

CREATE TABLE leases (
  task_id      TEXT PRIMARY KEY,
  holder       TEXT NOT NULL,
  claim_event  TEXT NOT NULL,
  claim_hlc    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  tentative    INTEGER NOT NULL DEFAULT 0,
  lost_by      TEXT
);

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
