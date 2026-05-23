---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance. Use when managing tasks, sessions, or multi-agent workflows with the CLEO CLI protocol.
metadata:
  version: 2.1.0
  lastReviewed: 2026-05-23
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

## Human Render Contract (ADR-077)

Every CLI command emits a typed `RenderableEnvelope<T>` from `@cleocode/contracts`.
Agents can route their own rendering off `envelope.data.kind` without re-parsing
the payload shape. Canonical patterns:

| Goal | Command |
|------|---------|
| Show one task (typed envelope; human render via core registry) | `cleo show T<id>` |
| Force human render when JSON is the default | `cleo show T<id> --human` |
| Generic hierarchy walker from any root (B9 / T10134) | `cleo tree T<id>` |

`cleo tree <id>` walks both `parent` and `task_relations.relation_type='groups'`
edges to full depth — useful for Saga → Epic → Task → Subtask snapshots from
any starting node.

### `RenderableEnvelope<T>` discriminator

`envelope.data.kind` is one of:

| `kind` | Payload shape | Renderer family |
|--------|---------------|-----------------|
| `'tree'` | `TreeResponse<T>` (flat-node form) | `renderTree` |
| `'table'` | `TableResponse<T>` (rows + schema) | `renderTable` |
| `'list'` | `ListResponse<T>` | `renderList` |
| `'grouped-list'` | `GroupedListResponse<T>` | `renderGroupedList` |
| `'section'` | `{icon, header, items}` | `renderSection` |
| `'single'` | single-record detail | per-command renderer |
| `'generic'` | fallback `Record<string, unknown>` | kv-block helper |

### Where the rendering lives

All rendering logic — registry, families, primitives — lives under
`packages/core/src/render/`. `packages/cleo/src/cli/renderers/index.ts` is a
~20-LOC thin dispatcher. Static UI primitives (Tree, Table, Section, Badge,
Legend) live under `packages/animations/render/`. Typed icon enums
(`StatusIcon`, `KindIcon`, `BadgeIcon`, `RelationIcon`) live in
`@cleocode/contracts/render/icon.ts`. Family renderers self-register at
module load via `registerRenderer(command, kind, fn)` — importing
`@cleocode/core/render` populates every slot via side-effect re-exports.

Full architecture + invariants: see `cleo docs fetch adr-077-human-render-contract`.

## Decomposing an epic into N tasks

When you need to bulk-create child tasks under an epic, use `cleo add-batch`. It inserts all
tasks in a single atomic transaction — if ANY task fails validation, ALL inserts are rolled back.
This is the canonical pattern for epic decomposition; prefer it over N sequential `cleo add` calls.

### Canonical command

```bash
cleo add-batch --file tasks.json --parent <epicId>
```

### Minimal JSON example

Create a `tasks.json` file (array of task objects):

```json
[
  {
    "title": "Research: survey add-batch prior art",
    "acceptance": "Written summary of 3+ prior approaches|Coverage of rollback semantics"
  },
  {
    "title": "Implement: add-batch CORE op with atomic semantics",
    "acceptance": "All tasks inserted or none|Returns IDs of created tasks"
  },
  {
    "title": "TF: teach add-batch in ct-cleo SKILL.md + CLEO-INJECTION",
    "acceptance": "SKILL.md contains Decomposing an epic section|INJECTION Task Creation table includes add-batch row"
  }
]
```

Every object in the array supports the same fields as `cleo add` (`title`, `acceptance`,
`kind`, `priority`, `size`, `labels`, `depends`). The `--parent` flag applies to all items.

### Flags

| Flag | Description |
|------|-------------|
| `--file <path>` | Path to JSON file (array of task objects) |
| `-` | Read JSON array from stdin (`echo '[...]' \| cleo add-batch --file - --parent <id>`) |
| `--parent <id>` | Parent epic/task ID. All created tasks become direct children. |
| `--dry-run` | Validate and preview all tasks without inserting. Shows what would be created. |

### Rollback semantic

```
ANY task fails → ALL inserts rolled back (zero partial state)
```

Run `--dry-run` first to catch validation errors (missing `acceptance`, title too long, etc.)
before committing the batch.

### Meta-dogfood: how T9813 itself was decomposed

The Epic T9813 (`add-batch` feature saga) used this exact pattern to create its child tasks
(T9814–T9819) in a single call. Use the task decomposition from your epic planning as the
input JSON — `cleo show <epicId>` acceptance criteria → tasks array → `cleo add-batch`.

### Related

- Saga/Epic workflow: `cleo briefing inject --section task-creation`
- Single task: `cleo add --type task --parent <id> --acceptance "..." --title "..."`
