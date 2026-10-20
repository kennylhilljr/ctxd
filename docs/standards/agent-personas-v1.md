# Standard: Agent Personas (v1)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-20 |
| **Owner** | H (the owner approves this standard); maintained by persona `doc-steward` |
| **Applies to** | Every agent persona that writes or reviews a document section in [docs/](../README.md) |
| **Related** | [Spec-driven development standard](spec-driven-development-v1.md), [templates](../templates/), [AGENTS.md](../../AGENTS.md) |

An agent persona is a named, scoped role an agent plays when it writes or reviews part of a document. Every section tagged **A** (agent-generated) or **C** (co-authored) in a template names the persona that writes it, so a reader always knows who produced a section and which rules bound it. Sections tagged **H** have no persona: only the owner writes them, although `analyst` may interview the owner to capture the answers.

## 1. Where personas live

| What | Where | Why |
|---|---|---|
| This standard (the minimum requirements and the roster) | `docs/standards/agent-personas-vN.md` | Humans review and approve it like any other document |
| Each persona's runnable definition | `.claude/agents/<name>.md` | Claude Code discovers subagents there; they are versioned with the code they write about |
| The pointer for agents without subagents (Codex and others) | [AGENTS.md](../../AGENTS.md) "Personas" section | Codex reads AGENTS.md; it follows the same definitions by hand |
| Which persona writes which section | The `> Owner` line under each heading in [docs/templates/](../templates/) | The assignment travels with every new document |

Personas do not go in `tools/`, which holds executable checks (lint, trace checks), and they are not documents in the spec stack, so they do not get a layer of their own.

## 2. Minimum requirements for a persona definition

A persona file is valid only if it has every item below. `doc-steward` checks new and changed persona files against this list before they are merged.

| # | Requirement | Detail |
|---|---|---|
| 1 | **Identity** | Frontmatter `name` (kebab case, matches the file name) and `description` (one sentence: when to use it). The body states the persona's version. |
| 2 | **Purpose** | One short paragraph: the job, in the owner's terms. |
| 3 | **Owned sections** | The template sections it writes, each tagged A or C. A persona never owns an H section. |
| 4 | **Inputs** | What it must read first, in order: AGENTS.md (the constitution), then the layer above its output, then the sections it derives from. |
| 5 | **Outputs** | The exact files it writes and their format. It always creates the next numbered version; it never edits a past version. |
| 6 | **Tools** | A least-privilege `tools` list in the frontmatter. Reviewers (`security-reviewer`, `verifier`) are read-only plus the commands that run checks. |
| 7 | **Boundaries** | What it must never do. Every persona inherits the common boundaries in section 3. |
| 8 | **Gate** | Which human gate reviews its output (Gate 1 spec, Gate 2 HLD, Gate 3 LLD and contracts) and whom it hands off to. |
| 9 | **Definition of done** | Checks it runs before handing off: IDs present and traced, links resolve, style rules pass, open questions listed rather than guessed. |
| 10 | **Escalation** | When it stops and asks the owner: a missing H answer, two answers that conflict, or any decision that cannot be undone. |

Optional: model and effort guidance, examples of good output, and known failure modes.

## 3. Common boundaries (every persona)

1. Never write or invent H content (problem, outcomes, scope, invariants, NFR values, fixed constraints). If it is missing, list it as an open question.
2. Never approve its own work, and never verify work it produced. `verifier` and `security-reviewer` review what others wrote.
3. Never change a section owned by another persona; raise a comment or open question instead.
4. Cite requirement and criterion IDs for every derived statement, so traceability can be checked.
5. Follow AGENTS.md: no real project, scope or pool names; no secrets; no em dashes, en dashes or double hyphens in prose; never edit a past numbered version.
6. Mark every assumption as an assumption, in the document's open-questions or assumptions section.

## 4. Roster

| Persona | Writes (A) | Drafts for a decision (C) | Gate | Definition |
|---|---|---|---|---|
| `analyst` | Research and prior-art documents; the intake record of the owner's answers | None; may interview the owner for H sections | Before Gate 1 | [analyst.md](../../.claude/agents/analyst.md) |
| `product-writer` | PRD acceptance criteria (EARS), edge cases, assumptions and open questions, glossary entries, requirement IDs and traceability | User stories (the owner names them; the persona writes them out) | Gate 1 | [product-writer.md](../../.claude/agents/product-writer.md) |
| `architect` | HLD component breakdown, data flow and sequence diagrams, capacity estimates, risks | ADR options and tradeoffs, system context, integrations | Gate 2 | [architect.md](../../.claude/agents/architect.md) |
| `security-reviewer` | Security sections of LLDs (enforcement points, detectors, key handling), always for human review | Trust boundaries and threat model | Gates 2 and 3 | [security-reviewer.md](../../.claude/agents/security-reviewer.md) |
| `component-designer` | LLD module structure, algorithms, error handling, configuration and flags; contracts and persisted schema (for human review) | None | Gate 3 | [component-designer.md](../../.claude/agents/component-designer.md) |
| `test-architect` | Test plan, criteria-to-test map, coverage gaps | None | Gate 3 | [test-architect.md](../../.claude/agents/test-architect.md) |
| `sre` | Observability, runbooks, operations LLD sections | Rollout and migration strategy (the owner sets risk tolerance) | Gates 2 and 3 | [sre.md](../../.claude/agents/sre.md) |
| `planner` | Milestone plans, slices and dependency-ordered task lists | None | Gate 3 (skimmed) | [planner.md](../../.claude/agents/planner.md) |
| `implementer` | Code and tests for one task at a time; the handoff | None | Code review | [implementer.md](../../.claude/agents/implementer.md) |
| `verifier` | Traceability and drift findings, review reports | None | Every gate (independent check) | [verifier.md](../../.claude/agents/verifier.md) |
| `doc-steward` | Doc map, glossary upkeep, version and link hygiene, persona file checks | None | None (mechanical) | [doc-steward.md](../../.claude/agents/doc-steward.md) |
