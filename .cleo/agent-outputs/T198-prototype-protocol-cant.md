# T198: Prototype subagent-protocol-base.cant — Complete

**Agent**: cleo-historian
**Date**: 2026-03-30
**Epic**: T191 (CANT DSL Subagent Prompt Exploration)
**Status**: complete

---

## Summary

Created `packages/skills/skills/_shared/subagent-protocol-base.cant` — a CANT equivalent of the existing `subagent-protocol-base.md`. Uses `kind: protocol` document type with categorized constraints, lifecycle phases, typed tokens, and structured anti-patterns.

---

## Comparison

| Aspect | Markdown (227 lines) | CANT (131 lines) |
|--------|---------------------|------------------|
| Output requirements | Prose table | `constraints [output]:` (4 rules) |
| Lifecycle phases | Numbered markdown steps | `phase` blocks with constraint refs |
| Token reference | Markdown tables | `tokens:` block with types |
| Anti-patterns | Markdown table | Structured triples |
| Error handling | Prose sections | Integrated into phases |
| Research linking | Separate section | Constraint BEH-003 |
| Completion checklist | Markdown checkbox list | Covered by lifecycle constraints |

**42% fewer lines** (227 → 131) with better structure.

---

## Linked Tasks

- Epic: T191
- Task: T198
