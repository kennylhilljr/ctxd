# Glossary

| | |
|---|---|
| **Owner** | A, maintained by personas `product-writer` (new terms) and `doc-steward` (upkeep) |
| **Rule** | One definition per term, linked to the document that specifies it. A term changes only through that document's next version |

## Product terms

| Term | Definition | Specified in |
|---|---|---|
| Brief | A budgeted, deterministic assembly of a scope's most useful entries, in `micro`, `normal` or `full` size | [LLD: Briefs and search](lld/LLD-briefs-search-v1.md) 11.1 |
| Claim (lease) | A time-limited statement that a client is working on a task, optionally with write intent | [LLD: Claims](lld/LLD-claims-v1.md) 7.5 |
| Client | An agent installation with its own token, for example `claude-code@air`; every write is attributed to one | [LLD: Data model](lld/LLD-data-model-v1.md) 4 |
| Drift | Files changed under a claim that its declared write intent did not cover | [LLD: Claims](lld/LLD-claims-v1.md) 7.5.4 |
| Entry | One unit of knowledge, with a kind, a status and independently versioned parts | [Knowledge model](prd/components/PRD-knowledge-model-v4.md) |
| Event | An immutable record of one change to one part of one entry; the event log is the source of truth | [ADR 0002](adr/0002-event-log-sync.md) |
| Holding scope | `_hold.<client>`: where writes an agent may not place are held, `proposed`, for the owner | [LLD: Write path](lld/LLD-write-path-v1.md) 6 |
| HLC | Hybrid logical clock that orders events across nodes | [LLD: Data model](lld/LLD-data-model-v1.md) 5 |
| Hook | A client lifecycle event that runs `ctxd hook <event>` | [LLD: Hooks](lld/LLD-hooks-v1.md) 9 |
| Journal | Short, immutable records of what happened, each with a significance | [Memory and journal](prd/components/PRD-memory-journal-v2.md) |
| Node | One machine running `ctxd server` with its own replica, role `home` or `roaming` | [LLD: Replication](lld/LLD-replication-v1.md) 7 |
| Open signal | A blocker, incident, blocking task or open flag, pinned in briefs until resolved | [LLD: Briefs and search](lld/LLD-briefs-search-v1.md) 11.4 |
| Part | One independently versioned piece of an entry: content, status, relations, claim, meta or embedding | [LLD: Data model](lld/LLD-data-model-v1.md) 4 |
| Path | A stable `ctxd://<scope>/<folder>/<file>` address for every entry and folder | [LLD: Data model](lld/LLD-data-model-v1.md) 4.2 |
| Persona pool | A named set of scope grants shared by the agents assigned to it | [Persona pools and access](prd/components/PRD-pools-access-v3.md) |
| Persona token | A token that fixes which pools a session may use | [LLD: MCP server](lld/LLD-mcp-server-v1.md) 8.4 |
| Purge | The one operation that erases content and rewrites stored events, everywhere | [LLD: Context hygiene](lld/LLD-context-hygiene-v1.md) 7.6.6 |
| Quarantine | Hiding one source's changes over a time window as a batch, for revert or release | [LLD: Context hygiene](lld/LLD-context-hygiene-v1.md) 7.6.2 |
| Scope | A project or area of life; every entry belongs to exactly one | [Knowledge model](prd/components/PRD-knowledge-model-v4.md) |
| Sealed pool | A pool stored in a separate encrypted file whose key needs Touch ID | [LLD: Security and access](lld/LLD-security-access-v1.md) 10.6 |
| Skill | A `SKILL.md` procedure shared with every agent after the owner approves it | [Skills](prd/components/PRD-skills-v3.md) |
| Write intent | The repository-relative path patterns a claim expects to change | [LLD: Claims](lld/LLD-claims-v1.md) 7.5.1 |

## Documentation terms

| Term | Definition | Specified in |
|---|---|---|
| A, C, H | Section ownership tags: agent-generated, co-authored (agent drafts, owner decides), human-authored | [SDD standard](standards/spec-driven-development-v1.md) |
| Acceptance criterion | One testable statement with an ID (`<prefix>-AC-n`), written in EARS | [Test plan](test/test-plan-v1.md) |
| ADR | Architecture decision record: numbered once, superseded rather than versioned | [ADR template](templates/adr-template.md) |
| Constitution | The rules every agent and document obey; in this repository, `AGENTS.md` | [AGENTS.md](../AGENTS.md) |
| Contract | The external surface of a component (MCP tools, CLI); changes need owner approval | [contracts/](contracts/) |
| EARS | Easy Approach to Requirements Syntax: ubiquitous, event-driven, state-driven, unwanted-behavior, optional-feature and complex patterns | [SDD standard](standards/spec-driven-development-v1.md) |
| Gate | A human approval point: Gate 1 spec, Gate 2 HLD, Gate 3 LLD and contracts | [SDD standard](standards/spec-driven-development-v1.md) |
| Given/When/Then | Gherkin (BDD) notation; an accepted alternative to EARS when criteria run as BDD scenarios | [SDD standard](standards/spec-driven-development-v1.md) |
| HLD | High-level design for the whole system; here, the Spec | [Spec v10](spec/SPEC-v10.md) |
| Layer | One level of the document stack, L0 vision to L6 code and evidence | [Doc map](README.md) |
| LLD | Low-level design for one component | [lld/](lld/) |
| Persona | A named, scoped role an agent plays when it writes or reviews a section | [Persona standard](standards/agent-personas-v1.md) |
| Seed questions | The twelve questions whose answers let agents derive the rest of the stack | [SDD standard](standards/spec-driven-development-v1.md) |
