# <Product> Component PRD: <Component> (vN)

| | |
|---|---|
| **Status** | Draft vN |
| **Date** | YYYY-MM-DD |
| **Supersedes** | vN-1 (`PRD-<component>-vN-1.md`) |
| **Parent** | PRD vN (`../PRD-vN.md`) |
| **Siblings** | Links to the latest version of each |
| **Spec** | Spec vN (`../../spec/SPEC-vN.md`) (HLD) sections; detail in the LLD |
| **Acceptance tests** | Test plan (`../../test/test-plan-vN.md`), <PREFIX> section |
| **Parent requirements elaborated** | FR-..., NFR-... |

Copy this file to the target folder as `<name>-v1.md`. Every section carries an owner line: **H** human-authored, **C** co-authored, **A** agent-generated, with the persona that writes it ([persona standard](../standards/agent-personas-v1.md)). Delete the owner lines only if your tooling does not need them; never delete a section, write "None" instead.

## Changes in vN
> **A** · written by `product-writer`

## 1. Purpose
> **H** · the owner writes it


## 2. Scope: in, out, non-goals
> **H** · the owner writes it · Gate 1


## 3. Invariants: what must never happen
> **H** · the owner writes it · Gate 1


## 4. Behavior
> **C** · `product-writer` drafts options, the owner decides · Gate 1

How the component behaves for the user, in the owner's terms. User stories: the owner names them, the persona writes them out.

## 5. Component requirements
> **C** · `product-writer` drafts options, the owner decides · Gate 1

| ID | Requirement | Parent | Priority |
|---|---|---|---|
| <PREFIX>-1 | | FR-n | P0 |

## 6. Edge cases and error behavior
> **A** · written by `product-writer` · spot-checked at Gate 1

## 7. Acceptance criteria
> **A** · written by `product-writer` · Gate 1

One EARS statement per criterion (Given/When/Then only if the spec declares it instead). Patterns: Ubiquitous "The <system> shall <response>"; Event-driven "When <trigger>, the <system> shall <response>"; State-driven "While <state>, ..."; Unwanted behavior "If <condition>, then the <system> shall <response>"; Optional feature "Where <feature is included>, ..."; Complex: combinations.

| ID | EARS pattern | Acceptance criterion | Traces to |
|---|---|---|---|
| <PREFIX>-AC-1 | Event-driven | When ..., the ... shall ... | <PREFIX>-1 |

## 8. Assumptions and open questions
> **A** · written by `product-writer` · resolved by the owner before Gate 1
