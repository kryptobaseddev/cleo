---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance. Use when managing tasks, sessions, or multi-agent workflows with the CLEO CLI protocol.
metadata:
  version: 2.3.0
  lastReviewed: 2026-05-24
  stability: stable
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
| Create a Saga | `cleo saga create --title "..." --acceptance "..."` |
| Link Epic to Saga | `cleo saga add <sagaId> <epicId>` |
| List Saga members | `cleo saga members <sagaId>` |

## Skill-Specific Extensions

- Task hierarchy, Saga commands, add-batch decomposition, docs policy, and CLI output details live in CLEO-INJECTION.md; emit `task-creation`, `documents`, and `pre-complete-gate` when needed.
- For add-batch input, The top-level JSON MUST be an array of task objects, not an object wrapper like `{ "tasks": [...] }`.
- Dry-run count semantics: `/data/count` and `/data/wouldCreate` predict writes; `/data/insertedCount` must be `0` for dry-run.
- Mutation output paths: use `/data/created/0`, `/data/updated/0`, and `/data/deleted/0`; never parse legacy full records.
- Docs path policy and strict preflight: keep docs repo-relative, Do not pass arbitrary external absolute paths, and discover runtime kinds with `cleo docs list-types` / `DocKindRegistry`.
