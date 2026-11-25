# ctxd Component PRD: Persona Pools and Access (v3)

| | |
|---|---|
| **Status** | Draft v3 |
| **Date** | 2026-10-20 |
| **Supersedes** | [v2](PRD-pools-access-v2.md) |
| **Parent** | [ctxd PRD v8](../PRD-v8.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v4.md), [Hooks and agent lifecycle](PRD-hooks-v6.md), [Claims and write intent](PRD-claims-v4.md), [Trust and safety](PRD-trust-safety-v5.md), [Context hygiene](PRD-context-hygiene-v2.md), [Replication](PRD-replication-v6.md), [Briefs and search](PRD-briefs-search-v5.md) |
| **Spec** | [Spec v10](../../spec/SPEC-v10.md) (HLD) sections 4, 6 (step 1), 8.4 and 10.5 to 10.7; detail in [LLD: Security and access](../../lld/LLD-security-access-v1.md), [LLD: MCP server](../../lld/LLD-mcp-server-v1.md) |
| **Acceptance tests** | [Test plan v1](../../test/test-plan-v1.md), PA section |
| **Parent requirements elaborated** | FR-10, FR-16, FR-33 to FR-36 |
| **Adapted from** | Role-based access control; [OpenViking](https://github.com/volcengine/OpenViking) accounts, users and directory ACLs; [DataHub](https://github.com/datahub-project/datahub) domains |

## Changes in v3

Earlier changes are listed in [v2](PRD-pools-access-v2.md) and before.

- **Acceptance criteria in EARS, with IDs.** Every criterion is now one EARS statement with an ID (`PA-AC-n`) and the component requirements it verifies. Each of the 12 criteria keeps its meaning. Each ID is mapped to its tests, or marked as a gap, in the [test plan](../../test/test-plan-v1.md).
- **Links.** The header points to PRD v8, Spec v10 (now the system HLD) and this component's LLD; sibling links point to current versions.

## 1. Purpose

Different agents do different jobs for me. A coding agent should see my software projects, a note-taking assistant my notes, and nothing should casually read my most private matters. Agents that work in the same area should share context freely; agents that don't should not see each other's. Some agents need several areas, a few need everything, and most need one.

**Persona pools** provide this. A pool is a persona, such as "pool-dev" or "pool-notes." It names the scopes its agents may use and at what level. Agents are assigned to pools.

## 2. Principles

1. **Default deny.** An agent sees only what its pools grant, plus the global `_me` profile. An agent with no pools can still record what it learns, but only into its own holding scope.
2. **Share inside a pool, not across.** Agents in the same pool share its scopes. A scope can be placed in several pools on purpose; nothing else crosses over.
3. **Least context, not just least privilege.** Each session assumes exactly one persona; an agent's other pools are unreachable in that session, not merely left out of the brief.
4. **I hold the keys.** Only the human CLI can create pools, change grants or assign agents. Agents cannot grant themselves anything.
5. **No writing into a pool without my permission.** An agent that is not a member of a pool can never write into that pool's scopes on its own. Its attempt becomes an access request that only I can approve.

## 3. Concepts

| Term | Meaning |
|---|---|
| **Pool (persona)** | A named set of scope grants plus default policies, for example `pool-dev`, `pool-notes`, `pool-ops`, `pool-private` |
| **Grant** | A scope in a pool, with a level: `read`, `propose` or `write` |
| **Member** | An agent installation (client) assigned to a pool directly, or through a tag such as `coding` |
| **Effective access** | For each scope, the highest level the agent gets from any of its pools or temporary grants |
| **Global `_me`** | My general preferences and conventions; readable by every agent, including unassigned ones |
| **Pool profile** | An optional `_me.<pool>` scope with persona-specific preferences, for example a preferred tone in `_me.pool-notes` |
| **Temporary grant** | A time-boxed grant of one scope to one agent, for example "codex@laptop may write to `notes` for 2 hours" |
| **The `all` pool** | Every scope at `write`; for me (the human CLI) and any agent I deliberately trust with everything |
| **Holding scope** | `_hold.<client>`: a private scope created automatically for an agent the first time it writes somewhere it may not (always the case for an agent in no pool). Held writes go there. Only that agent and I can read it, and everything in it is `proposed` |

### 3.1 Access levels

| Level | Read and search | Write | Claim tasks | Flag entries |
|---|---|---|---|---|
| `read` | Yes | No | No | Yes |
| `propose` | Yes | Yes, but every write arrives as `proposed` for my review | Yes | Yes |
| `write` | Yes | Yes, with the scope's normal review policy | Yes | Yes |

Flagging is allowed at every level, so even a read-only agent can report a wrong entry ([Context hygiene](PRD-context-hygiene-v2.md)).

## 4. Example setup

| Pool | Scopes and levels | Policies | Members |
|---|---|---|---|
| `pool-dev` | `ctxd` write, `sample-app` write, `shared-tools` write | Defaults for new scopes: replication `all`, vendor `any` | `claude-code@laptop`, `claude-code@air`, `codex@laptop` (tag `coding`) |
| `pool-notes` | `notes` write, `notes-archive` write | Profile `_me.pool-notes` (tone, banned punctuation) | `claude-desktop@laptop` |
| `pool-ops` | `project-b` write, `project-c` write, `shared-tools` read | | `claude-desktop@laptop` |
| `pool-private` | `private-a` propose, `private-b` propose | Sealed (7.1); replication `home`; vendor `local-only` | Local model on the Mac Studio only |
| `all` | Everything, write | | Human CLI |

In this setup, `shared-tools` is shared between `pool-dev` (write) and `pool-ops` (read). The Desktop app belongs to both `pool-notes` and `pool-ops`, but in a chat about `project-b` its brief contains only `pool-ops` context and global `_me`. No cloud agent can see `private-a` or `private-b`.

## 5. How access is decided

1. **Global `_me` first.** Every agent may read the global `_me`. Writes to it are `propose` for agents and `write` for me.
2. **Then grants.** For any other scope, the agent's level is the highest of its pools' grants (direct membership or tag) and its unexpired temporary grants. No grant means no access.
3. **Vendor policy still applies on top.** A `local-only` scope is never served to a cloud-model agent, whatever its pools say.
4. **Unassigned agents** read the global `_me` only. They **write to their own holding scope**, `_hold.<client>`, whatever scope they name:
   - **Redirected writes.** A write naming another scope is redirected there. The result says so ("stored in `_hold.cursor@laptop`; this agent is not assigned to a pool"), so the agent is never misled about where its note went.
   - **Private.** Each unassigned agent has its own holding scope. Unassigned agents never see each other's writes, and no other agent sees them.
   - **Proposed and contained.** Everything in a holding scope is `proposed`. Holding scopes never appear in other agents' briefs or searches, and they replicate only to home machines.
   - **Claims.** Unassigned agents cannot claim tasks.
   - **Notice.** Their SessionStart brief adds one line explaining how to assign them (`ctxd pool add-member <pool> <client>`).

   **Access requests.** When an unassigned agent tries to write to a scope that belongs to a pool, ctxd stores the write in the agent's holding scope and also opens an **access request**: which agent, which scope and pool, what it tried to write (as a reference to the held entry), and when. Repeated attempts update the same request instead of piling up. The request appears in `ctxd review` under "Access requests," with these choices:

   | Choice | Effect |
   |---|---|
   | **Allow this entry** | Promote just the held entry into the requested scope (as `proposed`, or `active` if I approve it at the same time) |
   | **Grant temporarily** | A temporary grant to that scope, for example 2 hours, at `propose` or `write` |
   | **Add to pool** | Make the agent a member of the pool |
   | **Deny** | Close the request; the held entry stays in the holding scope or is discarded |

   The agent is told in the tool result that its write needs my permission and is held, so it can tell me in the conversation. Nothing it wrote is visible to that pool's agents until I approve.

   When I review a holding scope, I can also **promote** entries into a project scope (`ctxd hold promote <ref> --to <scope>`), discard them, or assign the agent to a pool and move its holding scope's entries in one step (`ctxd hold adopt <client> --pool <pool> --to <scope>`).
5. **Every denial is logged** as metadata (agent, scope, tool, time), never content, and summarized in `ctxd review`.

## 6. Each session assumes one persona

Membership in a pool means an agent **may assume** that persona. A session runs under exactly one persona (or an explicit, human-issued combination). Everything the session does is checked against that persona alone: briefs, search, fetch, writes and claims. An agent that belongs to three pools behaves, in any one session, like an agent that belongs to one.

### 6.1 Persona tokens

- **One token per agent and pool.** `ctxd persona issue <client> <pool>` creates the token (human only). It is stored in the macOS Keychain under the `ctxd` service, never in environment variables, shell profiles or repository files.
- **The token is the assumed role.** The server maps each token to exactly one client and one pool (or one combination), and evaluates every call against that persona. Searching "everything" means everything in that persona.
- **Global token.** Each agent also has a `_me` token, used when no persona applies. It reaches only the global `_me` and the agent's own holding scope.
- **Combinations are explicit.** A session spanning two personas uses a combined token that I issue deliberately (`ctxd persona issue <client> <pool-a>,<pool-b>`). There is no automatic union.
- **Rotation and revocation.** `ctxd persona rotate` and `revoke` take effect on every machine at the next sync.

### 6.2 How a session picks its persona

No repository file names a pool or a project, because those files can end up on GitHub. Instead:

- **One MCP entry per agent.** Each agent has a single, generic MCP entry in its user-level configuration: `ctxd mcp --client <id>`. That is identical in every project and contains no names.
- **The launcher decides.** When the agent starts the ctxd MCP server inside a project, the launcher resolves the project's scope from ctxd's local data (the repository identity bound with `ctxd scope bind`). It picks the agent's pool that grants that scope and loads that persona's token from the Keychain.
- **Hooks use the same resolution**, so the SessionStart brief and the MCP tools always agree on the persona.
- **Overrides stay local.** `CTXD_POOL=<pool>` in the environment, or a per-project entry in the agent's *local, uncommitted* settings (for example Claude Code's local scope), overrides the resolution. Repository files are never needed.
- **Ambiguity is refused, not guessed.** If the agent has two pools granting the project's scope, the session starts under `_me` only, with a notice asking me to choose (`CTXD_POOL`, or a binding preference set with `ctxd persona prefer <client> <scope> <pool>`).

The rules below then apply within the assumed persona:

- **Brief.** At session start, ctxd resolves the project scope (from the repository or `.ctxd.toml`). The brief draws only from that scope, the global `_me`, and the profiles of the agent's pools that contain the scope.
- **Search and fetch.** Search defaults to the session's scope. Searching everything covers only scopes the agent can read.
- **Explicit persona.** Starting a session with `CTXD_POOL=<pool>` assumes that pool even outside a mapped project.
- **Out-of-pool project.** If the project's scope is not in any of the agent's pools, the brief contains only global `_me`. It adds the notice: "This project's context is not available to this agent."

## 7. Storage: one graph, with sealed pools

All ordinary pools share one database. Agents, pools, scopes and entries are nodes; membership, grants, containment and entry relations are edges. Access is a path: agent `may assume` pool `grants` scope `contains` entry.

### 7.1 Sealed pools

A pool can be **sealed** (`ctxd pool seal <pool>`), meant for the one or two truly sensitive personas:

- **Separate encrypted file.** Its scopes, entries, history and search indexes live in a separate encrypted database file. The file is named by the pool's internal id, not its name.
- **Key behind Touch ID.** The key is a random 256-bit key in the macOS Keychain, protected by user presence (Touch ID or the login password). The first use in a session prompts me, and the unlocked key is kept in memory for a limited window (one hour by default).
- **Attached only when needed.** The file is opened only for sessions whose persona token includes the sealed pool, after the key is unlocked. Other sessions never load it.
- **Replication to enrolled machines only.** It goes only to machines I enroll for that pool (normally the home hub). Changes travel encrypted with the pool key, so a machine that relays without the key cannot read them, and the laptop never receives them unless enrolled.
- **Backups.** They contain the file as ciphertext, encrypted again by the normal backup encryption.

### 7.2 Every hop is checked

Relations can cross pools; a decision in one pool may relate to a fact in another. Every traversal re-checks access on the target:

- following related entries;
- supersession chains;
- notices about superseded decisions;
- resolving references.

A target the session's persona cannot read appears only as an opaque reference, with no kind, title or summary. A sealed target also appears opaque while its pool is locked.

## 8. What this protects, and what it does not

| Threat | Protected? |
|---|---|
| A prompt-injected agent using ctxd's tools to read another persona's context | **Yes**: the session's token cannot reach it |
| Accidental cross-context leakage (a coding brief mentioning private matters) | **Yes** |
| An unassigned or new agent writing into a pool | **Yes**: held for my approval |
| A process reading a sealed pool's file from disk | **Yes**: it is encrypted, and the key needs my Touch ID |
| An agent with unrestricted shell access, running as my user, reading ctxd's main database file directly | **Partly**: the path guard blocks the common route, but shell access as my user is not a security boundary |
| That agent prompting the Keychain for a sealed key | **Only if I approve the Touch ID prompt** |

For a stronger boundary, run agents with their client's sandbox enabled (Claude Code's sandbox, Codex's workspace sandbox). That keeps ctxd's data directory outside what agent shells can read; with that, the path guard becomes a real control instead of a guard against accidents.

## 9. Pool policies

A pool can set defaults that apply to scopes created in it:

- replication;
- vendor policy;
- review policy;
- intent policy for claims.

A scope's own settings always win, and the strictest setting applies when a scope sits in several pools (for example `local-only` beats `any`).

## 10. Management

All commands are human-only:

| Command | Effect |
|---|---|
| `ctxd pool create <name> [--description ...]` | Create a pool |
| `ctxd pool grant <pool> <scope> --level read\|propose\|write` / `revoke` | Add or remove a scope grant |
| `ctxd pool add-member <pool> <client>\|tag:<tag>` / `remove-member` | Assign agents |
| `ctxd client tag <client> <tag>` | Tag an agent |
| `ctxd grant <client> <scope> --level <level> --for 2h` | Temporary grant (P2) |
| `ctxd persona issue\|rotate\|revoke <client> <pool>[,<pool>]` | Persona tokens, stored in the Keychain |
| `ctxd persona prefer <client> <scope> <pool>` | Resolve ambiguity when two of an agent's pools grant a scope |
| `ctxd pool seal <pool>` / `enroll <pool> <node>` / `lock <pool>` | Sealed pools: encrypt, add a machine, drop the in-memory key now |
| `ctxd access <client>` | Show an agent's effective access and why ("via pool pool-dev, tag coding") |
| `ctxd hold list` / `show <client>` | Holding scopes and their entries |
| `ctxd hold promote <ref> --to <scope>` / `discard <ref>` | Move one entry into a project scope, or drop it |
| `ctxd hold adopt <client> --pool <pool> [--to <scope>]` | Assign the agent and move its approved holding entries |
| `ctxd pool show <pool>` | Grants, members, policies |

Pool definitions replicate to every machine as metadata, so an agent has the same access on the laptop and the Air.

## 11. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| PA-1 | Pools with scope grants at `read`, `propose` and `write` | FR-33 | P0 |
| PA-2 | Membership by client or tag; effective access is the highest level across pools and temporary grants | FR-33 | P0 |
| PA-3 | Default deny; unassigned agents read global `_me` only and write only to their own private holding scope, with every write `proposed` and the redirect reported in the result | FR-33 | P0 |
| PA-13 | Holding scopes are private to their agent and me, excluded from other briefs and searches, replicated to home machines only; promote, discard and adopt from the CLI | FR-33 | P0 |
| PA-14 | An agent can never write into a pool it is not a member of without my approval; attempts open a deduplicated access request (allow entry, grant temporarily, add to pool, deny) | FR-33 | P0 |
| PA-15 | Agents that *are* in some pools but write to a scope outside them get `SCOPE_FORBIDDEN` with an access request opened the same way (the write is held in their own holding scope) | FR-33 | P1 |
| PA-4 | Global `_me` readable by all agents; optional `_me.<pool>` profiles readable by that pool's members | FR-34 | P0 |
| PA-5 | Each session assumes one persona, enforced on every call by a persona token; briefs from the session's scope, global `_me` and that pool's profile | FR-35 | P0 |
| PA-16 | Persona tokens per agent and pool in the Keychain; combinations only when issued explicitly; rotation and revocation replicate | FR-35 | P0 |
| PA-17 | Persona chosen by the launcher from ctxd's local bindings; no pool or project names in any repository file; ambiguity refused with a notice | FR-35 | P0 |
| PA-18 | Sealed pools in a separate encrypted file with a Touch ID protected key, attached only for that persona, replicated only to enrolled machines | FR-42 | P1 |
| PA-19 | Every traversal re-checks access; unreadable targets are opaque references | FR-31 | P0 |
| PA-6 | `propose` level forces every write to `proposed` | FR-33 | P0 |
| PA-7 | Temporary grants with expiry | FR-36 | P2 |
| PA-8 | Pool default policies; the strictest wins across pools | FR-33 | P1 |
| PA-9 | Only the human client can change pools, grants, members and tags | FR-10 | P0 |
| PA-10 | Denials logged as metadata and summarized in review | FR-32 | P1 |
| PA-11 | `ctxd access <client>` explains effective access | FR-33 | P1 |
| PA-12 | Pool definitions replicate; access is identical on every machine | FR-13 | P1 |
| PA-20 | A sealed pool's key can be rotated on demand, re-encrypting its file and un-enrolling every other machine until it re-enrolls | FR-42 | P2 |

## 12. Acceptance criteria

> Owner: A (agent-generated) by persona `product-writer`, derived from the requirements above; pending the owner's approval at Gate 1. Verification status per criterion: [test plan](../../test/test-plan-v1.md).

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| PA-AC-1 | Unwanted behavior | If an agent tries to read, search or claim in a scope its persona does not grant, then ctxd shall refuse and record the attempt as a rejection. | PA-3, PA-10 |
| PA-AC-2 | State-driven | While an agent in two pools works in a scope that only one of them grants, its brief shall contain no content from the other pool. | PA-5 |
| PA-AC-3 | Event-driven | When a `propose`-level agent writes a decision, ctxd shall store it as `proposed`, even in a scope that auto-accepts confirmed decisions. | PA-6 |
| PA-AC-4 | Event-driven | When a temporary grant expires, ctxd shall stop honoring it with no action taken. | PA-7 |
| PA-AC-5 | State-driven | While a session's persona is one pool, no tool shall return an entry from another pool the same client belongs to. | PA-5, PA-16 |
| PA-AC-6 | Ubiquitous | ctxd shall resolve a session's persona without any pool or scope name in a repository file. | PA-17 |
| PA-AC-7 | Event-driven | When a session in the sealed persona makes its first call, ctxd shall request the pool key once, and sessions in other personas shall never open the sealed file. | PA-18 |
| PA-AC-8 | Event-driven | When a traversal reaches an entry in a scope the persona cannot read, ctxd shall return only an opaque reference. | PA-19 |
| PA-AC-9 | Event-driven | When a new, unassigned agent starts a session, its brief shall contain the global conventions and an unassigned notice, and nothing else. | PA-3, PA-4 |
| PA-AC-10 | Event-driven | When an unassigned agent writes a decision into a project scope, ctxd shall hold it in that agent's holding scope as `proposed`, name the holding scope in the result, and keep it invisible to other agents. | PA-3, PA-13 |
| PA-AC-11 | Event-driven | When the human runs `ctxd hold adopt`, ctxd shall move the holding scope's approved entries into the project scope and add the agent to the pool in one step. | PA-13 |
| PA-AC-12 | Event-driven | When the same agent repeats a held write into one scope, ctxd shall keep a single access request, count the attempts, and write nothing to that scope until the human decides. | PA-14 |
| PA-AC-13 | Event-driven | When the human rotates a sealed pool's key, ctxd shall re-encrypt that pool's file under a new key, keep the pool openable on this machine, and un-enroll every other machine until it completes a fresh key transfer. | PA-20, PA-18 |

## 13. Open questions

| # | Question |
|---|---|
| PQ-1 | Should pools nest (for example `pool-dev` includes `shared-tools-readers`) or stay flat? Proposed: flat for v1 |
| PQ-2 | ~~Spanning two pools?~~ Decided: only with an explicitly issued combined persona token (6.1) |
| PQ-3 | ~~Should agents be able to request access?~~ Decided: yes, implicitly, by attempting the write (section 5, rule 4). An explicit request tool is not needed |
| PQ-4 | Should a holding scope expire (for example, discard unreviewed entries after 60 days)? Proposed: list them in `ctxd tidy` instead |
