# ctxd LLD: Data Model, Identifiers and Clocks (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Layer** | L4 low-level design |
| **Parent** | [Spec v10](../spec/SPEC-v10.md) sections 4 and 5 |
| **Implements** | [Knowledge model](../prd/components/PRD-knowledge-model-v4.md), [Filesystem view](../prd/components/PRD-filesystem-view-v2.md) (paths), [Skills](../prd/components/PRD-skills-v3.md) and [Memory and journal](../prd/components/PRD-memory-journal-v2.md) (kinds), [Replication](../prd/components/PRD-replication-v6.md) (identifiers and clocks) |
| **Owner** | A (agent-generated) by persona `component-designer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/store/schema.ts`, `src/core/`, `src/model/`, `src/fsview/` |
| **Moved from** | Spec v9 sections 4, 4.1 to 4.3 and 5; Spec v10 draft W5.1, W5.2 and W2 (schema) |

Section numbers are the Spec's own (for example 9.1), unchanged from Spec v9, so references in code comments, PRDs and AGENTS.md still resolve. Detail here is normative; [Spec v10](../spec/SPEC-v10.md) states the system-level design.

## 4. Data model

The **event log is the source of truth**. Entry state, FTS and vectors are materialized from it and can be rebuilt with `ctxd rebuild`.

The schema below is the executable one, copied from `src/store/schema.ts` at schema version 22. If this block and that file ever disagree, the file is what runs; raise the difference rather than silently diverging (AGENTS.md).

```sql
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
  repo         TEXT PRIMARY KEY,       -- normalized origin, e.g. github.com/example/sample-app
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

CREATE TABLE peer_watermarks (          -- the served-side mirror of sync_state (W3): how far we've served each peer, per origin
  peer_id      TEXT NOT NULL,
  origin_node  TEXT NOT NULL,
  through_seq  INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (peer_id, origin_node)
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
```

**Field notes:**

- **Parts and revisions** ([Knowledge model](../prd/components/PRD-knowledge-model-v4.md) section 4). Each part has its own revision, `"<version>-<10 chars of event_id>"`, CouchDB style: `content_rev`, `status_rev` and `relations_rev`. The 10 characters are the *last* 10 of the event's ULID, inside its random suffix, not the first 10 (a ULID's timestamp, which two events minted in the same millisecond would share); found as a real collision while building M3 slice 3's conflict policies, src/core/ids.ts's `makeRev`. The claim part lives in `leases`. An event changes exactly one part (`events.part`), and its `parent_revs` refer to that part's revisions. Clients pass `expected_rev` for the part they change, which for `context_write` updates is the content revision.
- **`parent_revs`** is the rev (or revs, for `resolve`) an event was based on. Creates have `[]`.
- **`payload`** holds the changed fields only; **`prev`** holds their prior values, so history, diffs and review never need to replay the log.
- **`slug`** is computed once at create (4.2) and never changes, so paths are stable across renames and machines. It replicates in the create event's payload.
- **`summary`** is required on read. If an agent omits it, it is derived at write time from the first sentence of the body (at most 200 characters, cut at a word boundary).
- **Reserved scopes** (`scopes.kind`):
  - **`me`:** the global `_me`, created by `ctxd init` with replication `all` and vendor policy `any`. Every client may read it; agents write to it at `propose`.
  - **`profile`:** `_me.<pool>`, created with a pool and owned by it; readable and writable at its members' levels.
  - **`hold`:** `_hold.<client>`, created on first need for a client; readable only by that client and the human client; replication `home`; every entry `proposed`.
- **Access metadata** (pools, grants, members, temporary grants, tags) changes only through `acl` events from the human client, in the reserved `_system` scope, and replicates to every node.
- **Purged entries** keep their row as a stub: `purged_at`, `purge_fingerprint`, and empty `title`, `summary` and `body` (title becomes `[purged]`). The purge event carries enough of the entry's structure (`scope_id`, `kind`, `slug`) that this stub is reconstructed deterministically on replay, whatever order the entry's events apply in (7.6.6).
- **Immutable kinds:** `decision`, `handoff`, `pointer` and `journal` take only `create` and `status` operations after creation. Changing a decision means a new decision with `supersedes` set; the old one moves to `superseded`.
- **Genesis exception.** `ctxd init` writes the first node row, the human client and the global `_me` scope with direct inserts, not through `acl` events, because there is no prior node, client or scope yet to author an event from. This is the one, deliberately narrow exception to "every change is an event" (ADR 0002); every write after it goes through the normal event path.
- **Approval timestamps.** `approved_by` and `approved_hlc` are set whenever an entry is actually approved: on the review path (`ctxd review --approve`, the `resolve` status event) to the approving human client and that event's HLC, and at creation for an auto-accept review rule match (10.4) to the creating client and the create event's HLC, since the rule itself is the approval. They stay NULL for a write that was never under review: the human client writing directly, or a kind whose unreviewed default status is already `active`. (Spec v10 draft W5.1.)
- **`sessions.cwd`** is recorded once, at SessionStart, and kept for the session's life; a later event's reported `cwd` never overwrites it. The crash sweep (9.10) reads it. (Spec v10 draft W5.2.)
- **`peer_watermarks`** is the served-side mirror of `sync_state`: per `(peer_id, origin_node)`, the highest `origin_seq` this node has served that peer. The pull handler writes it right after serving a page, taking the max against any existing value so a retried or out-of-order page never regresses it (7.1). It backs real sync age and unsynced counts in `ctxd doctor` and `ctxd status` (12, 9.11). (W3, schema version 22.)
- **Key transfer tables.** `node_encryption_keys` and `sealed_key_transfers` back the sealed pool key transfer in [LLD: Security and access](LLD-security-access-v1.md) section 10.6.1. (Spec v10 draft W2.)

### 4.1 References and relations

Implements [Knowledge model v4](../prd/components/PRD-knowledge-model-v4.md) sections 5 and 6.

- **References.** `ctxd:<scope name>/<entry ULID>`. The ULID alone identifies the entry; the scope name is for readability and is not trusted for lookup. Wherever a reference is accepted, a `ctxd://` path (4.2) and `skill:<name>` (4.3) are accepted too. Resolving a reference whose entry is `superseded` returns the entry plus `superseded_by` (following the chain to its end, at most 20 hops).
- **Relations.** Rows in `relations`, changed through `relate` and `unrelate` events on the `relations` part:

| Type | Source kind | Target |
|---|---|---|
| `supersedes` | Any | Entry of the same kind |
| `implements` | `task`, `note` | `decision` or `convention` |
| `derived_from` | `lesson`, `fact`, `decision` | Any entry |
| `blocks` | `task` | `task` |
| `relates_to` | Any | Any entry |
| `points_to` | Any | `file:<repo-relative path>`, `commit:<sha>` or `url:<https URL>` |
| `caused` | Any | Any entry, usually a `journal` blocker or incident, or a flagged entry |
| `resolved` | Any | A `journal` entry with significance `blocker` or `incident`, or a `task` (closes its signal, 11.4) |

- **Cross-scope targets** are allowed when the writing client can read the target scope (PRD KQ-1); readers who cannot read the target see the reference without content.
- **Supersession notices.** When a `decision` or `convention` becomes `superseded`, every active `task` with an `implements` relation to it gets a brief notice for its scope, and a claim holder gets it in their next brief.

### 4.2 Paths

Implements [Filesystem view](../prd/components/PRD-filesystem-view-v2.md) sections 2 and 3. Paths are computed from entries; the only stored part is `entries.slug`.

**Form.** `ctxd://<scope name>/<folder>/<file>`, where the folder and file depend on the kind:

| Kind | Path inside the scope |
|---|---|
| `brief` | `brief.md` (one per scope) |
| `status`, `decision`, `convention`, `lesson`, `handoff`, `task`, `pointer`, `note`, `preference` | `<plural folder>/<slug>.md`: `status/` (not pluralized), `decisions/`, `conventions/`, `lessons/`, `handoffs/`, `tasks/`, `pointers/`, `notes/`, `preferences/` |
| `fact` | `facts/<slug>.md`; in `_me` and `_me.<pool>` scopes, `profile/<slug>.md` |
| `skill` | `skills/<skill name>/SKILL.md` |
| `journal` | `journal/<YYYY>/<MM>/<DD>.md#<slug>`; the day file holds that day's entries in time order |

Journal dates use the local date of the node rendering the view, and day files must be real dates (`02/31.md` is rejected). Facts live in `profile/` only in `_me` and `_me.<pool>` scopes and in `facts/` only elsewhere, so each fact has exactly one path. A `#` fragment is allowed only on a journal day file. The view is not replicated, so a traveling node in another time zone may group a late entry under a different day; the entries themselves are unaffected.

**Slug.** Computed once when the entry is created:

1. Take the title, apply NFKD and drop combining marks, then lowercase.
2. Replace each run of characters outside `a-z` and `0-9` with `-`, and trim `-` from both ends.
3. Cut to 48 characters. Unless the cut falls exactly at the end of a word, cut back to the last `-` within the limit, if there is one. If the result is empty, use the kind name.
4. Append `-` and the last 6 characters of the entry's ULID, lowercased.

For example, `Use an event log, not cr-sqlite` with id `01JAB...7K2PQZ` becomes `use-an-event-log-not-cr-sqlite-7k2pqz`. The slug never changes, even when the title does.

**Collisions.** Two entries share a path only if they are in the same scope and kind, with titles that slug alike and the same last six id characters (30 random bits). Because nodes create entries offline, uniqueness is not enforced. A path that matches several entries resolves like a folder listing of those entries, never to an arbitrary one.

**Resolution** under the session's persona:

1. **Parse.** Reject `..`, empty segments, characters outside the grammar, and unknown folders with `VALIDATION`.
2. **Scope.** Look up the scope by name and evaluate `level` (10.5). If it is `none`, return `NOT_FOUND`, exactly as for a scope that does not exist, so unreadable scopes are invisible (the denial is still recorded in `rejections`).
3. **Target.** An entry file resolves to the entry; a folder resolves to a listing (below); `brief.md` resolves to the scope's `brief` entry.

**Folders and summaries.** Each folder has a generated one-line `.abstract` and an `.overview`. Both are assembled without a model at read time:

| Folder | `.abstract` (at most 200 characters) | `.overview` (at most about 4,000 characters) |
|---|---|---|
| `ctxd://` | Number of readable scopes | One line per readable scope with its `.abstract` |
| Scope | The scope's description, or its `brief` entry's summary | The `brief` entry's body, then a count per kind folder |
| Kind folder | `<n> entries; newest: <summary>` | Up to 15 summary lines, ranked by importance (11.3) |
| `skills/<name>/` | The skill's description | The SKILL.md frontmatter |
| Journal year or month | Entry count and counts by significance | One line per day: counts and the day's most significant entry |

Listings show `active`, `proposed` (labeled) and `flagged` (labeled) entries. Quarantined, deleted, purged, superseded and archived entries are left out unless the human CLI asks for them with `--all`.

**In tools.** `context_get` accepts paths among its `ids`; a folder path returns `{folder: {path, abstract, overview, children: [{path, ref?, kind?, summary, status?}]}}`, cut to `max_tokens` with `truncated` set. `context_search` accepts `path` (a folder prefix) and returns `path` for every result.

### 4.3 Preferences, skills and journal entries

Implements [Skills](../prd/components/PRD-skills-v3.md) section 2 and [Memory and journal](../prd/components/PRD-memory-journal-v2.md) sections 2 and 3.

**`preference`**

- Editable. Usually in `_me` or a pool profile; allowed in any scope.
- Agent writes are always `proposed`. No review rule can change that (10.4).
- Review-by default: 365 days.

**`skill`**

- **Name.** `title` is the skill name and must match `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters. It is stored in `skill_name`.
- **Body.** A `SKILL.md`: a YAML frontmatter block between `---` lines, then Markdown instructions. The frontmatter must contain `name`, equal to the title, and `description`, 1 to 1,024 characters. Other keys (for example `when_to_use`, `allowed-tools`, `disable-model-invocation`) are kept as written. The summary is the description, cut to 200 characters.
- **Approval.** Agent writes are always `proposed`, and no review rule can change that (10.4). A proposed skill is visible only to its author and the human client: search, `context_get`, `skill:<name>` lookup, folder listings, catalogs and native sync skip it for everyone else.
- **Lookup.** `skill:<name>` resolves to the active skill with that name in the session scope, then the matching pool profile, then `_me`. This needs a session scope to rank by; `context_get`'s `ids` parameter has no `scope` field of its own, so there is no new tool parameter for this, to keep the tool surface small (PRD NFR-4). Instead, the server uses the session's resolved scope once the hook lifecycle (9.2) records one on the session row. Until a session row carries a scope, the fallback holds: search the client's whole readable set and break ties by earliest `created_hlc`.
- **Name clashes.** Entries created offline may share a name in one scope. Lookup, catalogs and sync use the one with the earliest `created_hlc`; the others are listed in `ctxd review` as a name clash and are not served until renamed or retired. This is derived on read, so every node agrees without extra events.
- **Size.** The normal 20,000-character body limit applies. Supporting files are not supported in v1.

**`journal`**

- **Text.** `title` is the event (at most 200 characters). `body` is optional detail, at most 1,000 characters.
- **Significance.** One of `routine`, `milestone`, `breakthrough`, `blocker`, `incident`, `decision`; defaults to `routine`. Giving `significance` on any other kind is a `VALIDATION` error.
- **Immutable.** Corrections are a new journal entry that `relates_to` the old one, or a flag.
- **Status.** `active`, except significance `decision`, which is `proposed`.
- **Signals.** `blocker` and `incident` entries open a signal (11.4).
- **Mechanical entries.** Hooks write session and commit entries tagged `auto` (9.2); a commit entry's facts also land in the local `commits` table (7.5.6). Weekly digests are tagged `digest` (11.5).
- **No review-by date.**

## 5. Identifiers and clocks

- **ULIDs** for `entry_id`, `event_id`, `node_id` and `client_id`.
- **Hybrid logical clock (HLC)**, encoded as a fixed-width sortable string: `<physical ms, 13 hex digits>-<counter, 4 hex digits>-<node_id>`.
  - **On a local event:** `physical = max(now, last.physical)`. If unchanged, the counter increments.
  - **On receiving an event:** take the max of local, remote and now, per the standard HLC algorithm.
  - **Why:** HLC orders concurrent events deterministically across nodes, with the `node_id` suffix breaking exact ties.
- **`origin_seq`** is a per-node monotonic integer and drives sync cursors.
