# ctxd Component PRD: Skills (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-18 |
| **Parent** | [ctxd PRD v6](../PRD-v6.md) |
| **Siblings** | [Knowledge model](PRD-knowledge-model-v3.md), [Filesystem view](PRD-filesystem-view-v1.md), [Memory and journal](PRD-memory-journal-v1.md), [Persona pools and access](PRD-pools-access-v2.md), [Hooks and agent lifecycle](PRD-hooks-v5.md), [Claims and write intent](PRD-claims-v3.md), [Trust and safety](PRD-trust-safety-v4.md), [Context hygiene](PRD-context-hygiene-v1.md), [Replication](PRD-replication-v4.md), [Briefs and search](PRD-briefs-search-v4.md) |
| **Spec** | [Spec v6](../../spec/SPEC-v6.md) sections 4.3, 6, 10.4, 11.1, 12.2 and 13 (`skills`) |
| **Parent requirements elaborated** | FR-46 to FR-49 |
| **Adapted from** | [OpenViking](https://github.com/volcengine/OpenViking) shared skills and the `<available-skills>` catalog; the SKILL.md format used by [Claude Code](https://code.claude.com/docs/en/skills) and Codex |

## 1. Purpose

A **skill** is a reusable procedure written for agents, for example "how to cut a release" or "how I like code reviews done." Today, a skill I write for Claude Code lives in Claude Code's folder, Codex never sees it, and a better version written in one session is lost to the others.

ctxd stores skills once and makes them available to every agent that should have them: versioned, reviewed and scoped by persona.

## 2. What a skill is

- **A new entry kind, `skill`.** The body is a standard `SKILL.md`: YAML frontmatter with `name` and `description` (what it does and when to use it), followed by Markdown instructions. That is the format Claude Code and Codex already load.
- **Where skills live.**
  - **Global:** skills in `_me` reach every agent.
  - **Persona:** skills in a pool profile (`_me.<pool>`) reach only that persona.
  - **Project:** skills in a project reach only sessions in that project.
- **Path.** Skills appear in the filesystem view at `ctxd://<scope>/skills/<name>/SKILL.md` ([Filesystem view](PRD-filesystem-view-v1.md)).
- **Contents.** v1 skills are a single `SKILL.md`. Supporting files and scripts are out of scope until there is a safe way to deliver them.

## 3. How agents get skills

1. **The catalog.** Every session's brief includes a short **skill catalog**: the name and one-line description of each active skill the session's persona can read, within its own budget (about 600 characters by default). This mirrors how clients list skills before loading them.
2. **On demand.** When a skill applies, the agent reads it with `context_get` (by name, reference or path) and follows it.
3. **Native delivery (optional).** `ctxd skills sync --client <id>` writes approved skills into the client's personal skills folder, so they load natively, including from the `/` menu:
   - **Claude Code:** `~/.claude/skills/<name>/SKILL.md`.
   - **Codex:** its user skills folder (verify the path at the pinned version).

   Those folders are not persona-aware, so **only global `_me` skills are synced natively by default**; persona and project skills stay behind the catalog, where the session's persona controls access. Synced files carry a header naming their ctxd reference, and the sync never touches skills it did not write.

## 4. Writing and improving skills

- **Agents can propose skills.** After a procedure works well, an agent can save it as a skill (`context_write`, kind `skill`). The Stop-hook nudge can suggest this when a session repeated a multi-step procedure.
- **Proposed until I approve.** Skills are instructions that other agents will follow, which makes them the most sensitive kind of entry. A proposed skill is never shown in any catalog or synced anywhere until I approve it. Remembered approval rules cannot auto-accept skills.
- **Versions and history.** Edits create new revisions. History shows who changed what, and a bad change can be reverted or the skill flagged like any entry ([Context hygiene](PRD-context-hygiene-v1.md)).
- **Lessons attach to skills.** A lesson can relate to the skill it concerns (`derived_from`), and the skill's view lists them, so improvements are easy to fold in.

## 5. Safety

- **No secrets.** Skill bodies go through sanitization like any write; a skill containing a secret is rejected. Skills refer to credentials by name (for example "use the deploy key from the Keychain"), never by value.
- **Provenance in the catalog.** Each catalog line shows who wrote the skill; `context_get` shows its full history and approval.
- **No pre-approved tools.** Native sync removes `allowed-tools` from synced skills by default, so a skill can never grant itself tool permissions in a client.
- **Flag and quarantine.** A flagged skill disappears from catalogs and native folders immediately: the next sync removes the synced copy.

## 6. Component requirements

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| SK-1 | `skill` entry kind with a standard `SKILL.md` body (`name`, `description`, instructions) | FR-46 | P0 |
| SK-2 | Skills scoped to `_me`, pool profiles or projects; persona access rules apply | FR-46 | P0 |
| SK-3 | Skill catalog in every brief: active, readable skills only, within a budget | FR-47 | P0 |
| SK-4 | Agents fetch skills by name, reference or path with `context_get` | FR-47 | P0 |
| SK-5 | `ctxd skills sync` writes approved global skills into client skill folders, tagged and reversible; persona and project skills not synced by default | FR-48 | P1 |
| SK-6 | Agent-written skills always `proposed`; never in catalogs or synced until approved; review rules cannot auto-accept them | FR-49 | P0 |
| SK-7 | Flagged or quarantined skills removed from catalogs and from synced folders at the next sync | FR-49 | P0 |
| SK-8 | Lessons related to a skill are listed with it | FR-46 | P2 |

## 7. Acceptance criteria

- A skill approved in `_me` appears in the catalog of a Claude Code session and a Codex session, and after `ctxd skills sync` in Claude Code's `/` menu.
- A skill in one pool profile never appears in sessions of another persona.
- An agent-proposed skill is invisible to every other agent until I approve it.
- Flagging a synced skill removes its file from the client folder at the next sync.

## 8. Open questions

| # | Question |
|---|---|
| SQ-1 | Should supporting files (references, scripts) be allowed later, and under what review? |
| SQ-2 | Should I be able to import my existing personal Claude Code skills into `_me` in one step? Proposed: yes, `ctxd skills import --from claude-code`, as proposed entries |
