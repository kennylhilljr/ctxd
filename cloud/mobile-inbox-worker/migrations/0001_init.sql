-- Mobile inbox Worker (M7 slice 5): the cloud buffer's own schema, separate from ctxd's own
-- SQLite schema (src/store/schema.ts). This file holds nothing ctxd itself stores long-term;
-- `inbox_entries` rows are deleted as soon as the hub acks them (MI-3).

CREATE TABLE tokens (
  token_hash   TEXT PRIMARY KEY,         -- SHA-256 hex of the raw bearer token; the raw value is never stored
  role         TEXT NOT NULL CHECK (role IN ('client', 'hub')),
  label        TEXT NOT NULL,            -- e.g. "claude-mobile", "hub"; for the owner's own bookkeeping only
  created_at   TEXT NOT NULL
);

CREATE TABLE inbox_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  body         TEXT NOT NULL,            -- the entry's JSON content (scope, kind, title, body, tags?, clientRef?, capturedAt)
  created_at   TEXT NOT NULL
);

CREATE TABLE briefs (
  scope        TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,            -- JSON, whatever src/brief/assemble.ts produced for this scope
  updated_at   TEXT NOT NULL
);

CREATE TABLE rate_limits (
  token_hash   TEXT NOT NULL,
  window_start INTEGER NOT NULL,         -- floor(unix seconds / 60): a one-minute bucket
  count        INTEGER NOT NULL,
  PRIMARY KEY (token_hash, window_start)
);
