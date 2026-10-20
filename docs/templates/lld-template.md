# <Product> LLD: <Component> (vN)

| | |
|---|---|
| **Status** | Draft vN |
| **Date** | YYYY-MM-DD |
| **Layer** | L4 low-level design |
| **Parent** | Spec vN (`../spec/SPEC-vN.md`) sections ... |
| **Implements** | Component PRD (`../prd/components/PRD-<component>-vN.md`) (<PREFIX>-1 to <PREFIX>-n) |
| **Owner** | A by `component-designer`; human review at Gate 3 for contracts, persisted schema and access paths |
| **Code** | `src/<component>/` |

Copy this file to the target folder as `<name>-v1.md`. Every section carries an owner line: **H** human-authored, **C** co-authored, **A** agent-generated, with the persona that writes it ([persona standard](../standards/agent-personas-v1.md)). Delete the owner lines only if your tooling does not need them; never delete a section, write "None" instead.

Keep the HLD's section numbers as headings so code comments can cite them.

## n.1 Module structure and interfaces
> **A** · written by `component-designer` · review the code, not this section

## n.2 Data and schema
> **A** · written by `component-designer` · Gate 3: human review for anything persisted

## n.3 Contracts
> **A** · written by `component-designer` · Gate 3: human review for any public or cross-component contract

Or link to the file in docs/contracts/.

## n.4 Algorithms and procedures
> **A** · written by `component-designer`

## n.5 Error handling, retries, idempotency
> **A** · written by `component-designer` · spot-checked

## n.6 Security enforcement points
> **A** · written by `security-reviewer` · Gate 3: always human-reviewed

## n.7 Configuration and feature flags
> **A** · written by `component-designer`

Every flag: default, off behavior, and the test that proves the off path is inert.

## n.8 Observability
> **A** · written by `sre` · thresholds trace to NFRs

## n.9 Test notes
> **A** · written by `test-architect`

Which criteria this LLD's tests verify; the map itself is in the test plan.
