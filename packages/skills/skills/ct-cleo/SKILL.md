---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance. Use when managing tasks, sessions, or multi-agent workflows with the CLEO CLI protocol.
metadata:
  version: 2.4.0
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

## PM-Core V2 — Task Hierarchy (ADR-088)

**Canonical source:** `docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md`.
Legacy charter ADR-073 remains authoritative for pre-PM-Core V2 semantics; ADR-088
governs the PM-Core V2 target. T10638 migration removes legacy `task_relations.groups`
hierarchy reads and dual-shape `label='saga'` fallbacks.

| Tier    | Prefix | `type` value | Scope-of-change                         |
|---------|--------|-------------|-----------------------------------------|
| Saga    | `SG-`  | `saga`      | Theme grouping ≥2 Epics across releases |
| Epic    | `E-`   | `epic`      | One releasable slice; ≥1 PR to `main`   |
| Task    | `T-`   | `task`      | One atomic PR-sized change; single wave |
| Subtask | (none) | `subtask`   | One commit; ≤2 files                    |

**I1 — Containment:** `tasks.parent_id` is the **only** containment edge.
Direct children, ancestor/descendant traversal, closure rollups, and default
parent completion are all derived from `parent_id`.

**I2 — Storage:** All IDs stored as `T####`; `type` column discriminates tier
(not `label`). Prefixes (`SG-`, `E-`) are DISPLAY + import-mapping only.

**I3 — Non-containment:** `task_relations` is for secondary graph semantics ONLY
(dependency, ordering, cross-reference, evidence, supersession, provenance).
`task_relations` MUST NOT satisfy containment, child listing, ancestor/descendant
traversal, parent rollup, parent completion, nesting-budget, or closure semantics.

### Parent matrix

| Child type | Parent type    |
|------------|----------------|
| `subtask`  | `task`         |
| `task`     | `epic`         |
| `epic`     | `saga` or null |
| `saga`     | null           |

### Saga Operations (PM-Core V2)

Saga membership uses `parent_id` containment, not `task_relations.groups`.
Saga-level orchestration commands accept saga IDs directly:

```bash
# Saga-level ready frontier — parallel-safe tasks across all member epics
cleo orchestrate ready <sagaId>

# Saga-level dependency waves — unified wave plan
cleo orchestrate waves <sagaId>

# Saga status rollup — completion %, member counts
cleo saga rollup <sagaId>

# Membership via parent_id containment
cleo saga members <sagaId>
```

**Epic-level fallback:** If saga-level orchestrate fails, enumerate member epics
from `cleo saga members <sagaId>` and call `cleo orchestrate ready <epicId>` for
each member individually. Do not use `task_relations.groups` for hierarchy.

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

### Task Context (PM-Core V2 — T10629/T10630/T10631)

Bounded task context with token budgeting for agent ergonomics. Use `cleo context`
to get targeted task information without pulling full records:

```bash
# Get task context pack (identity, ACs, blockers, edges, activity)
cleo context T1234

# Get context with explicit token budget
cleo context T1234 --budget 800

# Saga-level aggregate rollup (completion %, ready-frontier, blockers)
cleo saga rollup <sagaId>
```

`coreTaskContext` returns identity, acceptance criteria, blockers, edges, and recent
activity respecting a configurable token budget. `TasksContextOmission` tracks budget
overages and provides expansion hints for scope refinement.

### WorkGraph (PM-Core V2 — T10632/T10633/T10634)

The WorkGraph subsystem validates and applies task graph scaffolds atomically:

```bash
# Validate a WorkGraph JSON payload against schema invariants (dry-run)
cleo graph validate --file workgraph.json

# Apply a validated WorkGraph scaffold (atomic create/update/delete)
cleo graph apply --file workgraph.json

# Generate a planning document from the WorkGraph
cleo graph plan T1234 --mode agent      # compact mode
cleo graph plan T1234 --mode maintainer  # prose mode
```

Scaffold validation returns `wouldCreate`/`wouldUpdate`/`wouldDelete`/`wouldAffect`
without side effects. `applyWorkGraphScaffold()` executes atomically in a single
transaction. `generatePlanningDoc()` produces structured markdown plans with
"agent" (compact) and "maintainer" (prose) output modes.

### Completion Criteria (PM-Core V2 — Typed ACs)

PM-Core V2 introduces typed acceptance criteria (`task_acceptance_criteria.kind`):

| Kind | Requires `target_task_id` | Purpose |
|------|--------------------------|---------|
| `text` | No | Human-authored acceptance criterion |
| `child_task` | **Yes** | Deterministic projection from a direct `parent_id` child |
| `evidence_bound` | No | Gate-backed criterion (`implemented`, `testsPassed`, `qaPassed`) |

Parent completion is derived deterministically from child state via `child_task`
projections (T10639 backfill). Mixed criteria mode is migration-only or explicit
advanced scope. Cancelled children require waiver or replacement evidence.
