# <Product> PRD (vN)

| | |
|---|---|
| **Status** | Draft vN |
| **Owner** | <name> |
| **Date** | YYYY-MM-DD |
| **Supersedes** | PRD vN-1 (`PRD-vN-1.md`) |
| **Parent** | Vision (`../vision/vision-vN.md`) |
| **Component PRDs** | Links to the latest version of each |
| **Companion docs** | Spec (HLD), test plan, ADRs |

Copy this file to the target folder as `<name>-v1.md`. Every section carries an owner line: **H** human-authored, **C** co-authored, **A** agent-generated, with the persona that writes it ([persona standard](../standards/agent-personas-v1.md)). Delete the owner lines only if your tooling does not need them; never delete a section, write "None" instead.

## Changes in vN
> **A** · written by `product-writer`

What changed since the previous version, with the section it changed.

## 1. Summary
> **H** · the owner writes it


## 2. Problem
> **H** · the owner writes it (`analyst` may interview to capture it) · Gate 1


## 3. Goals and non-goals
> **H** · the owner writes it · Gate 1

Goals (G1 ...) and explicit non-goals.

## 4. Users and surfaces
> **H** · the owner writes it (`analyst` may interview to capture it)


## 5. Core concepts
> **C** · `product-writer` drafts options, the owner decides

Terms are added to docs/glossary.md.

## 6. Components
> **C** · `architect` drafts options, the owner decides

| Component PRD | Covers | Elaborates | Requirement prefix | Spec sections | LLD |
|---|---|---|---|---|---|

## 7. Functional requirements
> **C** · `product-writer` drafts options, the owner decides · Gate 1 · the owner states each requirement; the persona writes IDs and wording

| ID | Requirement | Priority | Detailed in |
|---|---|---|---|

## 8. Non-functional requirements
> **H** · the owner writes it · Gate 1 · values are the owner's; `product-writer` makes them testable

| ID | Requirement |
|---|---|

## 9. Success metrics
> **H** · the owner writes it


## 10. Milestones
> **C** · `planner` drafts options, the owner decides

| Milestone | Scope | Exit criteria |
|---|---|---|

## 11. Risks and mitigations
> **A** · written by `architect` · Gate 1 · the owner ranks them


## 12. Open questions
> **A** · written by `product-writer`
