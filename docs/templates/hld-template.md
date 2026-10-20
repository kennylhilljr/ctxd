# <Product> Technical Specification (vN): System High-Level Design

| | |
|---|---|
| **Status** | Draft vN |
| **Date** | YYYY-MM-DD |
| **Layer** | L3 high-level design |
| **Owner** | C: `architect` drafts, the owner decides at Gate 2 |
| **Implements** | PRD vN (`../prd/PRD-vN.md`) |
| **Supersedes** | Spec vN-1 (`SPEC-vN-1.md`) |
| **Related** | ADRs, test plan |

Copy this file to the target folder as `<name>-v1.md`. Every section carries an owner line: **H** human-authored, **C** co-authored, **A** agent-generated, with the persona that writes it ([persona standard](../standards/agent-personas-v1.md)). Delete the owner lines only if your tooling does not need them; never delete a section, write "None" instead.

## Changes in vN
> **A** · written by `architect`

## How this spec is organized
> **A** · written by `doc-steward`

Section numbers are one namespace shared with the LLDs. Table: sections, topic, file that holds the detail.

### Traceability
> **A** · written by `product-writer`

| Component PRD | Spec sections | LLD and contracts |
|---|---|---|

## 1. Architecture
> **A** · written by `architect` · Gate 2

Components, listeners, stores and what calls what, as a diagram.

## 2. Stack
> **H** · the owner writes it · constitution · the approved stack lives in AGENTS.md; this section records it


## 3. Key decisions
> **C** · `architect` drafts options, the owner decides · Gate 2

One line per ADR, linked.

## 4 to N. One short section per component
> **A** · written by `architect` · Gate 2

A few sentences of system-level design and a link to the LLD.

## Threat model and trust boundaries
> **C** · `security-reviewer` drafts options, the owner decides · Gate 2

## Rollout and migration
> **C** · `sre` drafts options, the owner decides · Gate 2 · the owner sets risk tolerance

## Capacity and scaling
> **A** · written by `architect` · derived from the NFR values

## Risks
> **A** · written by `architect` · Gate 2 · the owner ranks them

## Testing strategy
> **A** · written by `test-architect`

Layers and tooling; per-criterion coverage is in the test plan.

## Repository layout
> **A** · written by `doc-steward`

## Open issues
> **A** · written by `architect`
