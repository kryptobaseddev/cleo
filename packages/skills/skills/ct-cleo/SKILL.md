---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance. Use when managing tasks, sessions, or multi-agent workflows with the CLEO CLI protocol.
metadata:
  version: 2.5.0
  lastReviewed: 2026-05-26
  stability: stable
---

# CLEO Protocol Guide

<!-- thin-pointer: full protocol is in CLEO-INJECTION.md (T9148) -->
Full protocol content lives in `~/.cleo/templates/CLEO-INJECTION.md`.
Emit any section with: `cleo briefing inject --section <name>`

Supported sections: `session-start` · `work-loop` · `triggers` · `task-creation`
· `task-discovery` · `task-relationships` · `session-commands` · `memory` · `nexus`
· `orchestration` · `playbooks` · `documents` · `error-handling` · `pre-complete-gate`
· `spawn-tiers` · `rules` · `memory-jit` · `escalation`

## Quick Reference

| Need | Command |
|------|---------|
| Start session | `cleo session status` → `cleo briefing` |
| Find work | `cleo next` → `cleo focus <id>` |
| Search tasks | `cleo find "query"` |
| Complete task | `cleo verify T### --gate ... --evidence "..."` → `cleo complete T###` |
| Save memory | `cleo memory observe "..." --title "..."` |
| Spawn subagent | `cleo orchestrate spawn <taskId> --tier 2` |
| Create a Saga | `cleo saga create --title "..." --acceptance "..."` |
| Saga-level ready | `cleo orchestrate ready <sagaId>` |
| Saga-level waves | `cleo orchestrate waves <sagaId>` |
| Saga rollup | `cleo saga rollup <sagaId>` |
| List Saga members | `cleo saga members <sagaId>` |

## Skill-Specific Extensions

- Task hierarchy, Saga commands, add-batch decomposition, docs policy, and CLI output details live in CLEO-INJECTION.md; emit `task-creation`, `documents`, and `pre-complete-gate` when needed.
- For add-batch input, The top-level JSON MUST be an array of task objects, not an object wrapper like `{ "tasks": [...] }`.
- Dry-run count semantics: `/data/count` and `/data/wouldCreate` predict writes; `/data/insertedCount` must be `0` for dry-run.
- Mutation output paths: use `/data/created/0`, `/data/updated/0`, and `/data/deleted/0`; never parse legacy full records.
- Docs path policy and strict preflight: keep docs repo-relative, Do not pass arbitrary external absolute paths, and discover runtime kinds with `cleo docs list-types` / `DocKindRegistry`.

### Task Relationship Systems — depends, blockedBy, relates

CLEO has **three distinct relationship systems** with different storage, semantics, and CLI exposure. Do not conflate them.

| System | Storage | Semantics | CLI Exposure |
|--------|---------|-----------|--------------|
| `depends` | `task_dependencies` table (`task_id`, `depends_on`) | **Blocking dependency** — task cannot start until all `depends` tasks are `done` | `cleo add --depends T1,T2` / `cleo update --depends` / `--add-depends` / `--remove-depends` |
| `blockedBy` | `tasks.blocked_by` column (free-text) | **Human-readable reason** why a task is blocked (e.g. "waiting for API key") | `cleo update --blocked-by "reason"` / `--clear-blocked-by` |
| `relates` | `task_relations` table (`task_id`, `related_to`, `relation_type`, `reason`) | **Semantic, non-blocking** relationships: `blocks`, `related`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes` | `cleo relates add <from> <to> <type> <reason>` / `cleo relates remove` / `cleo relates list` |

#### Key distinction

- **`depends`** controls **execution order** (wave planning, `cleo next` eligibility). It is a hard dependency.
- **`blockedBy`** is a **status annotation** — it does NOT link to another task, it just explains why this task is `blocked`.
- **`relates`** is **informational linkage** — it does NOT block execution, but it records that two tasks have a semantic relationship (e.g. "T1001 supersedes T1002" or "T1003 duplicates T1004").

#### CRITICAL: Do NOT use `relates` for execution gates

`relates` is **never** a blocking dependency. If task B must wait for task A to finish, use `--depends`:

```bash
# CORRECT — execution dependency
cleo add "Implement auth" --depends T1001,T1002

# WRONG — relates does NOT block execution
cleo relates add T1003 T1001 blocks "waiting for auth"
```

#### Common pitfall: using `blockedBy` for task IDs

`--blocked-by` expects a **string reason**, not task IDs. To express "this task is blocked until that task finishes", use `--depends`:

```bash
# CORRECT
cleo add "Implement auth" --depends T1001

# WRONG — blocked-by is free text, not a task reference
cleo update T1003 --blocked-by T1001
```

#### `cleo relates` command reference

```bash
# Add a semantic relationship
cleo relates add T1001 T1002 supersedes "T1002 is absorbed into the new auth flow"

# List relations for a task
cleo relates list T1001

# Remove a relation
cleo relates remove T1001 T1002

# Suggest related tasks based on shared attributes
cleo relates suggest T1001 --threshold=50

# Discover related tasks using various methods
cleo relates discover T1001
```

Valid relation types: `blocks`, `related`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes`.

#### Schema types mismatch note

The DB schema `TASK_RELATION_TYPES` (`related`, `blocks`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes`) must match the runtime types. The CLI `cleo relates add` accepts the DB schema types. Always normalize to the DB enum before persisting.

## Task Hierarchy (PM-Core V2 — ADR-088)

**Canonical source:** `docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md`.

| Tier    | Prefix | type value | Scope-of-change                                    |
|---------|--------|------------|----------------------------------------------------|
| Saga    | `SG-`  | `saga`     | Theme grouping ≥2 Epics across ≥2 releases         |
| Epic    | `E-`   | `epic`     | One releasable slice; ≥1 PR to `main`              |
| Task    | `T-`   | `task`     | One atomic PR-sized change; single wave            |
| Subtask | (none) | `subtask`  | One commit; ≤2 files; contributes to Task's PR     |

**Containment (I1):** `tasks.parent_id` is the **only** containment edge. Direct children,
ancestor/descendant traversal, closure rollups, and default parent completion are all derived
from `parent_id`. The parent matrix is:

| Child type | Parent type     |
|------------|-----------------|
| `subtask`  | `task`          |
| `task`     | `epic`          |
| `epic`     | `saga` or `null`|
| `saga`     | `null`          |

**Storage (I2):** All IDs stored as `T####`; `type` column discriminates tier (not `label`).
Prefixes (`SG-`, `E-`) are DISPLAY + import-mapping only.

**Non-containment (I3):** `task_relations` is for secondary graph semantics ONLY — dependency,
ordering, cross-reference, evidence, supersession, provenance. `task_relations` MUST NOT satisfy
containment, child listing, ancestor/descendant traversal, parent rollup, parent completion,
nesting-budget, or closure semantics. The `groups` relation type is retired; do not use it for
hierarchy.

## Typed Completion Criteria (PM-Core V2)

`task_acceptance_criteria.kind` is one of:

| Kind | Requires `target_task_id` | Purpose |
|------|--------------------------|---------|
| `text` | No | Human-authored acceptance criterion |
| `child_task` | **Yes** | Deterministic projection from a direct `parent_id` child |
| `evidence_bound` | No | Gate-backed criterion (`implemented`, `testsPassed`, `qaPassed`) |

**Key rules:**
- A parent with children uses `child_task` criteria by default; these are **deterministic
  projections** from `parent_id` containment.
- `text` and `evidence_bound` criteria must NOT use `target_task_id`.
- Cancelled children do NOT automatically satisfy parent completion.
- Adding child work under a done parent reopens affected ancestors.

## Saga Operations (PM-Core V2)

Saga-level orchestration is first-class. Saga membership uses `parent_id`
containment (NOT `task_relations.groups`). Use saga IDs directly with orchestrate commands:

```bash
# Saga-level ready frontier — parallel-safe tasks across all member epics
cleo orchestrate ready <sagaId>

# Saga-level dependency waves — unified wave plan across all member epics
cleo orchestrate waves <sagaId>

# Saga status rollup — completion %, member counts
cleo saga rollup <sagaId>

# Saga membership listing via parent_id containment
cleo saga members <sagaId>
```

**Epic-level fallback:** If saga-level orchestrate fails, enumerate member epics from
`cleo saga members <sagaId>` and call `cleo orchestrate ready <epicId>` for each member
individually. Do not use `task_relations.groups` as a fallback for hierarchy — it is
non-containment only per I3.

## WorkGraph (PM-Core V2)

The WorkGraph subsystem provides scaffold validation, atomic application, and planning
document generation:

| Feature | What it does |
|---------|--------------|
| Scaffold Dry-Run Validator | Validates WorkGraph JSON payloads against schema invariants before mutation. Returns `wouldCreate`/`wouldUpdate`/`wouldDelete` without side effects. |
| Scaffold Apply Engine | Atomically applies validated WorkGraph scaffolds to the task database. Creates, updates, and deletes tasks/relations/ACs in a single transaction. Sibling-relation-based (SQLite trigger blocks parent-child relation edges). |
| Planning Doc Generator | `generatePlanningDoc()` produces structured markdown plans from the WorkGraph. Supports "agent" (compact) and "maintainer" (prose) output modes. |

Example — dry-run a scaffold before applying:
```bash
# Validate scaffold payload
cleo workgraph validate --file scaffold.json --dry-run

# Apply validated scaffold atomically
cleo workgraph apply --file scaffold.json
```

## Task Context (PM-Core V2)

Bounded task context with token budgeting for agent ergonomics:

| Feature | What it does |
|---------|--------------|
| Task Context Pack | `coreTaskContext` returns targeted task information (identity, acceptance criteria, blockers, edges, activity) respecting a configurable token budget. Uses `TasksContextOmission` to track overages and provides expansion hints. |
| Saga Context & Readiness | Saga-level aggregate rollups: completion percentages, ready-frontiers, and blocker enumeration across all member epics via `parent_id` containment. |

Example — get task context for agent use:
```bash
# Full context with budget
cleo orchestrate report <taskId>

# Compact context for prompt injection
cleo focus <taskId>
```
