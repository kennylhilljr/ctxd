# ctxd Component PRD: Persona Pools and Access (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-18 |
| **Parent** | [ctxd PRD v4](../PRD-v4.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v2.md), [Hooks and agent lifecycle](PRD-hooks-v3.md), [Claims and write intent](PRD-claims-v3.md), [Trust and safety](PRD-trust-safety-v3.md), [Context hygiene](PRD-context-hygiene-v1.md), [Replication](PRD-replication-v3.md), [Briefs and search](PRD-briefs-search-v3.md) |
| **Spec** | [Spec v4](../../spec/SPEC-v4.md) sections 4 (`pools`, `pool_grants`, `pool_members`, `client_grants`), 10.5 and 11 |
| **Parent requirements elaborated** | FR-10, FR-16, FR-33 to FR-36 |
| **Adapted from** | Role-based access control; [OpenViking](https://github.com/volcengine/OpenViking) accounts, users and directory ACLs; [DataHub](https://github.com/datahub-project/datahub) domains |

## 1. Purpose

Different agents do different jobs for me. A coding agent should see my software projects, a note-taking assistant my notes, and nothing should casually read my most private matters. Agents that work in the same area should share context freely; agents that don't should not see each other's. Some agents need several areas, a few need everything, and most need one.

**Persona pools** provide this. A pool is a persona, such as "pool-dev" or "pool-notes." It names the scopes its agents may use and at what level. Agents are assigned to pools.

## 2. Principles

1. **Default deny.** An agent sees only what its pools grant, plus the global `_me` profile. An agent with no pools can still record what it learns, but only into its own holding scope.
2. **Share inside a pool, not across.** Agents in the same pool share its scopes. A scope can be placed in several pools on purpose; nothing else crosses over.
3. **Least context, not just least privilege.** Even an agent with several pools gets a brief only from the pool of the project it is working in.
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

Flagging is allowed at every level, so even a read-only agent can report a wrong entry ([Context hygiene](PRD-context-hygiene-v1.md)).

## 4. Example setup

| Pool | Scopes and levels | Policies | Members |
|---|---|---|---|
| `pool-dev` | `ctxd` write, `sample-app` write, `shared-tools` write | Defaults for new scopes: replication `all`, vendor `any` | `claude-code@laptop`, `claude-code@air`, `codex@laptop` (tag `coding`) |
| `pool-notes` | `notes` write, `notes-archive` write | Profile `_me.pool-notes` (tone, banned punctuation) | `claude-desktop@laptop` |
| `pool-ops` | `project-b` write, `project-c` write, `shared-tools` read | | `claude-desktop@laptop` |
| `pool-private` | `private-a` propose, `private-b` propose | Replication `home`, vendor `local-only` | Local model on the Mac Studio only |
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

## 6. Sessions narrow to one persona

An agent in several pools still works in one context at a time:

- **Brief.** At session start, ctxd resolves the project scope (from the repository or `.ctxd.toml`). The brief draws only from that scope, the global `_me`, and the profiles of the agent's pools that contain the scope.
- **Search and fetch.** Search defaults to the session's scope. Searching everything covers only scopes the agent can read.
- **Explicit persona.** Starting a session with `CTXD_POOL=writing` narrows it to that pool even outside a mapped project.
- **Out-of-pool project.** If the project's scope is not in any of the agent's pools, the brief contains only global `_me`. It adds the notice: "This project's context is not available to this agent."

## 7. Pool policies

A pool can set defaults that apply to scopes created in it:

- replication;
- vendor policy;
- review policy;
- intent policy for claims.

A scope's own settings always win, and the strictest setting applies when a scope sits in several pools (for example `local-only` beats `any`).

## 8. Management

All commands are human-only:

| Command | Effect |
|---|---|
| `ctxd pool create <name> [--description ...]` | Create a pool |
| `ctxd pool grant <pool> <scope> --level read\|propose\|write` / `revoke` | Add or remove a scope grant |
| `ctxd pool add-member <pool> <client>\|tag:<tag>` / `remove-member` | Assign agents |
| `ctxd client tag <client> <tag>` | Tag an agent |
| `ctxd grant <client> <scope> --level <level> --for 2h` | Temporary grant |
| `ctxd access <client>` | Show an agent's effective access and why ("via pool pool-dev, tag coding") |
| `ctxd hold list` / `show <client>` | Holding scopes and their entries |
| `ctxd hold promote <ref> --to <scope>` / `discard <ref>` | Move one entry into a project scope, or drop it |
| `ctxd hold adopt <client> --pool <pool> [--to <scope>]` | Assign the agent and move its approved holding entries |
| `ctxd pool show <pool>` | Grants, members, policies |

Pool definitions replicate to every machine as metadata, so an agent has the same access on the laptop and the Air.

## 9. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| PA-1 | Pools with scope grants at `read`, `propose` and `write` | FR-33 | P0 |
| PA-2 | Membership by client or tag; effective access is the highest level across pools and temporary grants | FR-33 | P0 |
| PA-3 | Default deny; unassigned agents read global `_me` only and write only to their own private holding scope, with every write `proposed` and the redirect reported in the result | FR-33 | P0 |
| PA-13 | Holding scopes are private to their agent and me, excluded from other briefs and searches, replicated to home machines only; promote, discard and adopt from the CLI | FR-33 | P0 |
| PA-14 | An agent can never write into a pool it is not a member of without my approval; attempts open a deduplicated access request (allow entry, grant temporarily, add to pool, deny) | FR-33 | P0 |
| PA-15 | Agents that *are* in some pools but write to a scope outside them get `SCOPE_FORBIDDEN` with an access request opened the same way (the write is held in their own holding scope) | FR-33 | P1 |
| PA-4 | Global `_me` readable by all agents; optional `_me.<pool>` profiles readable by that pool's members | FR-34 | P0 |
| PA-5 | Session narrowing: briefs from the session's scope, global `_me` and matching pool profiles only; `CTXD_POOL` override | FR-35 | P0 |
| PA-6 | `propose` level forces every write to `proposed` | FR-33 | P0 |
| PA-7 | Temporary grants with expiry | FR-36 | P1 |
| PA-8 | Pool default policies; the strictest wins across pools | FR-33 | P1 |
| PA-9 | Only the human client can change pools, grants, members and tags | FR-10 | P0 |
| PA-10 | Denials logged as metadata and summarized in review | FR-32 | P1 |
| PA-11 | `ctxd access <client>` explains effective access | FR-33 | P1 |
| PA-12 | Pool definitions replicate; access is identical on every machine | FR-13 | P1 |

## 10. Acceptance criteria

- An agent in `pool-notes` cannot read, search or claim anything in `ctxd`, and the attempt is logged.
- An agent in both `pool-dev` and `pool-ops`, working in `project-b`, gets a brief with no `pool-dev` content.
- A `propose`-level agent's decision arrives as `proposed` even if the scope auto-accepts confirmed decisions.
- A temporary grant stops working when it expires, without any action.
- A new, unassigned agent sees my global conventions and a notice, and nothing else.
- That agent's attempt to write a decision into `ctxd` lands in its holding scope as `proposed`, the tool result names where it went, and no other agent can find it.
- `ctxd hold adopt` moves a holding scope's approved entries into a project scope and assigns the agent to a pool in one step.
- Ten attempts by the same unassigned agent to write into `pool-dev` produce one access request, and nothing appears in `pool-dev` until I choose "Allow this entry," "Grant temporarily" or "Add to pool."

## 11. Open questions

| # | Question |
|---|---|
| PQ-1 | Should pools nest (for example `pool-dev` includes `shared-tools-readers`) or stay flat? Proposed: flat for v1 |
| PQ-2 | Should a session be allowed to span two pools explicitly (`CTXD_POOL=pool-dev,pool-ops`)? |
| PQ-3 | ~~Should agents be able to request access?~~ Decided: yes, implicitly, by attempting the write (section 5, rule 4). An explicit request tool is not needed |
| PQ-4 | Should a holding scope expire (for example, discard unreviewed entries after 60 days)? Proposed: list them in `ctxd tidy` instead |
