# Tasks CRUD Audit — 2026-05-11

**Scope:** CLEO Tasks domain CRUD completeness  
**Trigger:** Missing `removeBlocks`/`removeBlockedBy` question from TaskUpdate tool audit  
**Auditor:** Read-only investigator agent  
**Files audited:**  
- `packages/core/src/tasks/task-ops.ts`  
- `packages/core/src/tasks/update.ts`  
- `packages/core/src/tasks/relates.ts`  
- `packages/contracts/src/operations/tasks.ts`  
- `packages/contracts/src/data-accessor.ts`  
- `packages/contracts/src/task.ts`  
- `packages/cleo/src/dispatch/domains/tasks.ts`  
- `packages/cleo/src/cli/commands/update.ts`  
- `packages/cleo/src/cli/commands/relates.ts`  
- `packages/cleo/src/cli/commands/promote.ts`

---

## Section 1 — Coverage Matrix

Legend: **WIRED** = CLI flag + SDK op + dispatch handler all present | **PARTIAL** = some layers present, some missing | **MISSING** = not implemented at any layer | **SDK-ONLY** = SDK op exists, no CLI/dispatch wire

> Note on `blocks`: CLEO does not have a first-class `blocks[]` field on the task record. "blocks" is a **relationship type** within `relates[]` (a `TaskRelation`), not a separate top-level field. `blockedBy` is a free-text string reason field (not derived from `depends`). These are distinct concepts.

### 1.1 depends

| Action | CLI flag | SDK op (update.ts / task-ops.ts) | Dispatch handler (tasks.ts) | Status |
|--------|----------|-----------------------------------|-----------------------------|--------|
| set    | `--depends` | `depends?: string[]` in `UpdateTaskOptions` | `params.depends` forwarded | **WIRED** |
| add    | `--add-depends` | `addDepends?: string[]` | `params.addDepends` forwarded | **WIRED** |
| remove | `--remove-depends` | `removeDepends?: string[]` | `params.removeDepends` forwarded | **WIRED** |

### 1.2 relates (semantic relationship table)

| Action | CLI command | SDK op | Dispatch handler | Status |
|--------|-------------|--------|-----------------|--------|
| add    | `cleo relates add <from> <to> <type> <reason>` | `coreTaskRelatesAdd` / `addRelation` in accessor | `relates.add` in MUTATE_OPS | **WIRED** |
| remove | — | — (no `removeRelation` in accessor or task-ops) | — | **MISSING** |
| list   | `cleo relates list <taskId>` | `listRelations` in relates.ts | `relates` query op | **WIRED** |
| set    | — (no batch-replace) | — | — | **MISSING** |

### 1.3 blockedBy (free-text reason string, NOT derived from depends)

| Action | CLI flag | SDK op | Dispatch handler | Status |
|--------|----------|--------|-----------------|--------|
| set    | `--blocked-by <reason>` | `blockedBy?: string` in `UpdateTaskOptions` | forwarded as `blockedBy` | **WIRED** |
| clear  | — | — (no `blockedBy: null` path) | — | **MISSING** |

**Note:** `blockedBy` in the Task contract is `string | undefined`. The update.ts logic sets it via `task.blockedBy = options.blockedBy` only when `options.blockedBy !== undefined`. There is no way to pass `null` or `""` through the CLI to clear it. The `TasksUpdateQueryParams` contract also lacks a `clearBlockedBy` flag.

### 1.4 blocks (as relates type — no dedicated field)

| Action | CLI | SDK | Dispatch | Status |
|--------|-----|-----|----------|--------|
| add (via relates) | `cleo relates add <T1> <T2> blocks <reason>` | `coreTaskRelatesAdd` with `type="blocks"` | `relates.add` | **WIRED** (indirect) |
| remove | — | — | — | **MISSING** |

### 1.5 labels

| Action | CLI flag | SDK op | Dispatch handler | Status |
|--------|----------|--------|-----------------|--------|
| set    | `--labels` | `labels?: string[]` | `params.labels` forwarded | **WIRED** |
| add    | `--add-labels` | `addLabels?: string[]` | `params.addLabels` forwarded | **WIRED** |
| remove | `--remove-labels` | `removeLabels?: string[]` | `params.removeLabels` forwarded | **WIRED** |

### 1.6 files

| Action | CLI flag | SDK op | Dispatch handler | Status |
|--------|----------|--------|-----------------|--------|
| set    | `--files` | `files?: string[]` | `params.files` forwarded | **WIRED** |
| add    | — | — | — | **MISSING** |
| remove | — | — | — | **MISSING** |

**Note:** Files is set-replace only. Unlike labels/depends, there are no `--add-files` or `--remove-files` flags. The only way to add a file is to re-specify the entire array with `--files`.

### 1.7 acceptance

| Action | CLI flag | SDK op | Dispatch handler | Status |
|--------|----------|--------|-----------------|--------|
| set    | `--acceptance "AC1\|AC2"` | `acceptance?: string[]` | `params.acceptance` forwarded | **WIRED** |
| add    | — | — | — | **MISSING** |
| remove | — | — | — | **MISSING** |

**Note:** Acceptance is set-replace only. Mutation is guarded by AC-immutability (T1590) once in implementation stage — any add/remove helpers would need to respect that gate. No `addAcceptance`/`removeAcceptance` variant exists at any layer.

### 1.8 notes

| Action | CLI flag | SDK op | Dispatch handler | Status |
|--------|----------|--------|-----------------|--------|
| add    | `--notes` / `--note` | `notes?: string` (appends with timestamp) | `params.notes` forwarded | **WIRED** |
| clear  | — | — | — | **MISSING** |
| remove | — | — | — | **MISSING** |

**Note:** Notes is append-only by design. Clearing notes has no CLI flag, no SDK option, and no dispatch path.

### 1.9 parent

| Action | CLI | SDK op | Dispatch handler | Status |
|--------|-----|--------|-----------------|--------|
| set (reparent) | `cleo reparent <taskId> --to <parentId>` | `coreTaskReparent` | `reparent` in MUTATE_OPS | **WIRED** |
| set via update | `cleo update <taskId> --parent <parentId>` | `parentId` in `UpdateTaskOptions` | `params.parent` forwarded | **WIRED** |
| clear (promote) | `cleo promote <taskId>` | Routes to `reparent` with `newParentId: null` | `reparent` with `null` | **WIRED** |

### 1.10 type / kind / scope / severity — set

| Field | CLI flag | SDK op | Dispatch handler | Status |
|-------|----------|--------|-----------------|--------|
| type  | `--type` | `type?: TaskType` | forwarded | **WIRED** |
| kind  | `--kind` | `kind?: TaskKind` | forwarded | **WIRED** |
| scope | `--scope` | `scope?: TaskScope` | forwarded | **WIRED** |
| severity | `--severity` | `severity?: TaskSeverity` | forwarded | **WIRED** |

### 1.11 status — set

| Action | CLI flag | SDK op | Dispatch handler | Status |
|--------|----------|--------|-----------------|--------|
| set    | `--status` | `status?: TaskStatus` | forwarded | **WIRED** |

### 1.12 priority — set

| Action | CLI flag | SDK op | Dispatch handler | Status |
|--------|----------|--------|-----------------|--------|
| set    | `--priority` | `priority?: TaskPriority` | forwarded | **WIRED** |

---

## Section 2 — Specific Gaps

### GAP-1: `relates.remove` — Remove a semantic relationship

- **Where it should live:**  
  - Data layer: `DataAccessor.removeRelation(taskId, relatedId, type)` in `packages/contracts/src/data-accessor.ts`  
  - SDK op: `coreTaskRelatesRemove` in `packages/core/src/tasks/task-ops.ts`  
  - Dispatch: `relates.remove` added to `MUTATE_OPS` in `packages/cleo/src/dispatch/domains/tasks.ts`  
  - CLI: `cleo relates remove <from> <to> <type>` subcommand in `packages/cleo/src/cli/commands/relates.ts`  
  - Contract: `TasksRelatesRemoveParams` / `TasksRelatesRemoveResult` in `packages/contracts/src/operations/tasks.ts`; add to `TasksOps`
- **Canonical name:** `tasks.relates.remove` / `cleo relates remove`
- **Estimated effort:** S (the `addRelation` path is well-paved; this is a straight mirror)

### GAP-2: `clearBlockedBy` — Clear the blockedBy reason string

- **Where it should live:**  
  - SDK: Add `clearBlockedBy?: boolean` to `UpdateTaskOptions` in `packages/core/src/tasks/update.ts`; handle with `task.blockedBy = undefined`  
  - Dispatch contract: Add `clearBlockedBy?: boolean` to `TasksUpdateQueryParams` in `packages/contracts/src/operations/tasks.ts`  
  - CLI: Add `--clear-blocked-by` boolean flag to `packages/cleo/src/cli/commands/update.ts`
- **Canonical name:** `--clear-blocked-by` (CLI) / `clearBlockedBy: true` (SDK)
- **Estimated effort:** XS (single-field guard in update.ts + contract + CLI flag)

### GAP-3: `--add-files` / `--remove-files` — Incremental file list mutation

- **Where it should live:**  
  - SDK: Add `addFiles?: string[]` and `removeFiles?: string[]` to `UpdateTaskOptions` in `packages/core/src/tasks/update.ts`  
  - Logic: Mirror the `addLabels`/`removeLabels` pattern (Set-based merge/filter)  
  - Dispatch contract: Add fields to `TasksUpdateQueryParams`  
  - CLI: Add `--add-files` and `--remove-files` flags to `update.ts`
- **Canonical name:** `--add-files` / `--remove-files`
- **Estimated effort:** XS (identical pattern to labels which is already implemented)

### GAP-4: `--add-acceptance` / `--remove-acceptance` — Incremental AC mutation

- **Where it should live:**  
  - SDK: `addAcceptance?: string[]` and `removeAcceptance?: string[]` in `UpdateTaskOptions`  
  - AC-immutability gate: Both ops must pass through `enforceAcceptanceImmutability` (T1590); `--reason` flag already exists  
  - CLI: `--add-acceptance` / `--remove-acceptance` flags  
  - Contract: Add to `TasksUpdateQueryParams`
- **Canonical name:** `--add-acceptance` / `--remove-acceptance`
- **Estimated effort:** S (must respect AC-immutability guard and pipe-separated parse; AC is typed as `AcceptanceItem[]` not plain strings)

### GAP-5: `clearNotes` — Clear/reset notes array

- **Where it should live:**  
  - SDK: `clearNotes?: boolean` in `UpdateTaskOptions`; sets `task.notes = []`  
  - CLI: `--clear-notes` boolean flag  
  - Contract: `clearNotes?: boolean` in `TasksUpdateQueryParams`
- **Canonical name:** `--clear-notes` (CLI) / `clearNotes: true` (SDK)
- **Estimated effort:** XS (guard in update.ts; no complex logic needed)

### GAP-6: `relates.set` — Batch-replace all relations for a task

- **Where it should live:**  
  - SDK: `coreTaskRelatesSet` in task-ops.ts (replaces all `task.relates` entries; flushes task_relations table rows for taskId)  
  - Dispatch: `relates.set` in MUTATE_OPS  
  - CLI: `cleo relates set <taskId> --relations "T001:blocks:reason,T002:related:reason"` or via JSON  
- **Canonical name:** `tasks.relates.set` / `cleo relates set`
- **Estimated effort:** M (requires deletion from task_relations table, not just append; DataAccessor needs `removeAllRelations(taskId)`)

---

## Section 3 — Top 5 Most-Impactful Gaps (Ranked)

### 1. `relates.remove` (GAP-1) — HIGH IMPACT
Agents and operators have no way to remove a semantic relationship once added. A wrongly created `blocks`, `duplicates`, or `fixes` relation is permanent. This is the direct analog of the `removeBlocks`/`removeBlockedBy` question that triggered the audit. Every agent workflow that creates relates entries can get stuck with stale data. Effort: **S**.

### 2. `clearBlockedBy` (GAP-2) — HIGH IMPACT
`blockedBy` is a free-text reason string. Once set, it can be overwritten with a new string but **cannot be removed**. Agents marking a task unblocked via `cleo update --status active` do not clear the stale blockedBy reason, leaving misleading state visible in `cleo show`. Effort: **XS**.

### 3. `--add-files` / `--remove-files` (GAP-3) — MEDIUM IMPACT
The files field is frequently mutated during implementation — agents discover new files as they work. Currently, an agent must read the full existing file list, append to it, and rewrite the entire array via `--files`. This is fragile and noisy in audit logs. The `labels` field already has this pattern; files is an obvious parity gap. Effort: **XS**.

### 4. `--add-acceptance` / `--remove-acceptance` (GAP-4) — MEDIUM IMPACT
Acceptance criteria often need incremental refinement during research and consensus phases. The set-replace pattern forces agents to re-specify all ACs to add one. With the AC-immutability gate (T1590), the risk of accidental full-replace also increases (forgetting one AC silently drops it). Effort: **S**.

### 5. `clearNotes` (GAP-5) — LOW-MEDIUM IMPACT
Notes are append-only by design, which is correct for audit trails. However, for development tasks where exploratory notes accumulate, there is no maintenance path. Low-impact relative to the others but a XS fix if desired. Effort: **XS**.

---

## Section 4 — Recommendation

**Yes, create CLEO tasks for these gaps.** Five of the six gaps affect normal agent workflows. GAP-1 and GAP-2 are the most urgent because they involve operations agents routinely perform (blocking/unblocking, relates management) with no current remediation path other than direct DB manipulation.

**Proposed task titles:**

1. `Add tasks.relates.remove SDK op + CLI subcommand (cleo relates remove <from> <to> <type>)` — priority: high, kind: work
2. `Add --clear-blocked-by flag to cleo update + clearBlockedBy SDK option` — priority: high, kind: bug
3. `Add --add-files / --remove-files to cleo update (parity with labels)` — priority: medium, kind: work
4. `Add --add-acceptance / --remove-acceptance to cleo update (parity with labels, must respect AC-immutability gate T1590)` — priority: medium, kind: work
5. `Add --clear-notes boolean flag to cleo update + clearNotes SDK option` — priority: low, kind: work
6. `Add tasks.relates.set batch-replace op + DataAccessor.removeAllRelations(taskId)` — priority: low, kind: work (blocks item 1 if designed together)

---

## Appendix — Fully Wired Axes (No Action Needed)

- depends: set / add / remove — all three WIRED
- labels: set / add / remove — all three WIRED
- status: set — WIRED
- priority: set — WIRED
- type: set — WIRED
- kind: set — WIRED
- scope: set — WIRED
- severity: set — WIRED
- parent: set / clear — WIRED (via reparent + promote)
- relates: add / list / suggest / discover — WIRED

