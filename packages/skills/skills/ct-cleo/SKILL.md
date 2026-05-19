---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance. Use when managing tasks, sessions, or multi-agent workflows with the CLEO CLI protocol.
---

# CLEO Protocol Guide

<!-- thin-pointer: full protocol is in CLEO-INJECTION.md (T9148) -->
Full protocol content lives in `~/.cleo/templates/CLEO-INJECTION.md`.
Emit any section with: `cleo briefing inject --section <name>`

Supported sections: `session-start` · `work-loop` · `triggers` · `task-creation`
· `task-discovery` · `session-commands` · `memory` · `nexus` · `orchestration`
· `playbooks` · `documents` · `error-handling` · `pre-complete-gate`
· `spawn-tiers` · `rules` · `memory-jit` · `escalation`

## Quick Reference

| Need | Command |
|------|---------|
| Start session | `cleo session status` → `cleo briefing` |
| Find work | `cleo next` → `cleo show <id>` |
| Search tasks | `cleo find "query"` |
| Complete task | `cleo verify T### --gate ... --evidence "..."` → `cleo complete T###` |
| Save memory | `cleo memory observe "..." --title "..."` |
| Spawn subagent | `cleo orchestrate spawn <taskId> --tier 2` |
| Create a Saga (above-Epic group, ADR-073) | `cleo saga create --title "..." --acceptance "..."` |
| Link Epic to Saga | `cleo saga add <sagaId> <epicId>` |
| List Saga members | `cleo saga members <sagaId>` |

## Skill-Specific Extensions

### Task Hierarchy (canonical source: ADR-073 §1)

CLEO has 4 tiers. Each defined by scope-of-change + agent ownership. All IDs stored as `T####`;
`type` column discriminates; prefixes (`SG-`, `E-`, `T-`) are display + import-mapping only.

| Tier    | Prefix | Scope-of-change                                | Owner (ADR-070)     |
|---------|--------|-------------------------------------------------|----------------------|
| Saga    | `SG-`  | ≥2 Epics across ≥2 releases (themed grouping)   | Orchestrator (read)  |
| Epic    | `E-`   | One releasable slice; ≥1 PR to `main`           | Orchestrator (HITL)  |
| Task    | `T-`   | One atomic PR-sized change; single wave         | Phase Lead           |
| Subtask | (none) | One commit; ≤2 files; rolls up to Task's PR     | Worker (leaf)        |

**I8 — Subtask-to-PR aggregation:** A Task ships as exactly ONE PR. Subtasks contribute commits
to that single PR; Subtasks never own a PR. Promote a Subtask to a sibling Task if it warrants
its own PR.

Full charter (8 invariants + lifecycle decision table + prefix registry) lives in
`.cleo/adrs/ADR-073-above-epic-naming.md` §1–§2. CLI commands for Sagas: see
CLEO-INJECTION.md `task-creation` section (`cleo briefing inject --section task-creation`).

For full decision trees and operation reference tables, emit sections above.
