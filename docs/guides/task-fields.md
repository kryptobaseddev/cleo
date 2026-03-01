# Task Fields Reference

This guide covers every field on a CLEO task, what it means, and how to use it.

---

## Identity & Hierarchy

### `id`

The unique identifier for every task. Format: `T` followed by digits (e.g. `T001`, `T5164`). Assigned automatically on creation. Never changes, never reused.

```bash
ct show T001
```

> **Dev note**: Column `id TEXT PRIMARY KEY`, pattern `^T\d{3,}$`. Validated unique across active and archived tasks.

### `title`

A short, action-oriented summary. Must start with a verb ("Implement caching", "Fix login redirect"). Max 120 characters.

```bash
ct add "Fix login redirect bug"
```

> **Dev note**: Column `title TEXT NOT NULL`. Anti-hallucination validation requires title to differ from description (case-insensitive).

### `description`

A longer explanation of what the task involves. Max 2000 characters. Should provide enough context for someone (human or agent) to understand the work without reading further.

```bash
ct add "Fix redirect bug" --description "After login, users are redirected to /dashboard instead of their original URL"
```

> **Dev note**: Column `description TEXT`. Required by anti-hallucination rules but technically nullable in the DB. Must differ from `title`.

### `type`

Defines the task's role in the hierarchy. Three levels:

| Type | Role | Can have children? | Max children |
|------|------|--------------------|--------------|
| `epic` | Top-level initiative | Yes (tasks) | 7 per level |
| `task` | A unit of work | Yes (subtasks) | 7 per level |
| `subtask` | Smallest trackable unit | No | N/A |

Maximum depth is 3: `epic > task > subtask`. You cannot nest an epic inside another epic.

```bash
ct add "Auth system overhaul" --type epic
ct add "Implement JWT tokens" --parent T001      # becomes a task under the epic
ct add "Write token refresh test" --parent T002   # becomes a subtask
```

> **Dev note**: Column `type TEXT`, enum `['epic', 'task', 'subtask']`. Depth enforced by `E_DEPTH_EXCEEDED` (exit 11). Sibling limit enforced by `E_SIBLING_LIMIT` (exit 12), default 7.

### `parentId`

Links a task to its parent in the hierarchy. Set via `--parent` on creation.

```bash
ct add "Write unit tests" --parent T001
```

When a parent is deleted, `parentId` is set to `null` (the child becomes a root task, not deleted).

> **Dev note**: Column `parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL`.

### `position`

Display order among siblings under the same parent (or among root tasks). 1-indexed. Auto-assigned if not set. Used by `ct list` and plan views to control ordering.

> **Dev note**: Column `position INTEGER`. Has an optimistic lock counter `position_version INTEGER DEFAULT 0` that increments on each reorder to prevent concurrent edit conflicts.

---

## Status & Priority

### `status`

The current state of the task. Six possible values:

| Status | Meaning | Set by |
|--------|---------|--------|
| `pending` | Not started, waiting to be picked up | Default on creation |
| `active` | Currently being worked on | `ct start T001` |
| `blocked` | Cannot proceed (requires `blockedBy` text) | `ct update T001 --status blocked --blocked-by "Waiting on API key"` |
| `done` | Completed | `ct done T001` |
| `cancelled` | Abandoned (requires reason) | `ct cancel T001 --reason "Superseded by T050"` |
| `archived` | Moved to cold storage | `ct archive` |

**Valid transitions:**

```
pending ──> active, blocked, done, cancelled
active  ──> pending, blocked, done, cancelled
blocked ──> pending, active, done, cancelled
done    ──> pending, active          (reopen)
cancelled ──> pending                (restore)
```

> **Dev note**: Column `status TEXT NOT NULL DEFAULT 'pending'`. Enum defined in `src/store/status-registry.ts`. Transitions enforced by `validateStatusTransition()` in `src/core/validation/validation-rules.ts`.

### `priority`

How urgent/important the task is. Used by `ct next` to suggest what to work on.

| Priority | Score weight |
|----------|-------------|
| `critical` | 90 |
| `high` | 70 |
| `medium` | 50 |
| `low` | 35 |

```bash
ct add "Fix security vulnerability" --priority critical
ct update T001 --priority high
```

> **Dev note**: Column `priority TEXT NOT NULL DEFAULT 'medium'`, enum `['critical', 'high', 'medium', 'low']`.

### `size`

Relative scope of the work. Describes how much code is touched, NOT how long it takes (CLEO prohibits time estimates).

| Size | Meaning |
|------|---------|
| `small` | A few lines, one file |
| `medium` | Multiple files, moderate changes |
| `large` | Many files, significant changes |

```bash
ct add "Rename variable" --size small
```

> **Dev note**: Column `size TEXT`, nullable. Enum `['small', 'medium', 'large']`.

---

## Dependencies & Relations

This is the area with the most confusion, so here's the key distinction:

- **`depends`** = hard blockers. "I literally cannot complete until these are done."
- **`relates`** = soft links. "These are connected but don't block each other."
- **`blockedBy`** = free-text explanation. "Here's why I'm stuck right now."

### `depends` (blocking dependencies)

A list of task IDs that **must** be completed before this task can be marked done. This is a hard constraint enforced at completion time.

```bash
ct add "Deploy to production" --depends T010,T011
ct update T015 --depends T012
```

**What happens:**
- If you try `ct done T015` and T012 is still `pending`, you get a `DEPENDENCY_ERROR`.
- A cancelled dependency counts as satisfied (it's been resolved, just not via completion).
- When you complete T012, CLEO reports which downstream tasks are now "unblocked" (all their deps are satisfied). This is informational only -- their status does not auto-change.

**What does NOT happen:**
- `depends` does **not** automatically set `status` to `blocked`. A task with unresolved deps stays `pending` (or whatever status you set). The `ct plan` command will show it as effectively blocked in its output, but the stored status stays as-is.
- Completing a blocker does **not** auto-activate the dependent tasks. You still need to `ct start` them.

**Circular dependency protection:** CLEO validates the dependency graph with a depth-first search. If adding a dependency would create a cycle (A depends on B depends on A), the operation fails.

#### Dependency direction: both ways are queryable

When you query a task's dependencies (`ct deps T001` or via MCP `tasks.deps`), CLEO computes both directions from the graph:

- **`dependsOn`** -- tasks this one is waiting on (its `depends` list, resolved to `{ id, title, status }`)
- **`dependedOnBy`** -- tasks that are waiting on this one (computed by scanning all tasks whose `depends` include this ID)

Example graph:
```
T004  <──  T001  <──  T008
  ^
  └────  T005
```
(T008 depends on T001; T001 depends on T004; T005 depends on T004)

Querying **T004** returns:
- `dependsOn`: [] (T004 has no deps)
- `dependedOnBy`: [T001, T005]

Querying **T001** returns:
- `dependsOn`: [T004]
- `dependedOnBy`: [T008]

Querying **T008** returns:
- `dependsOn`: [T001]
- `dependedOnBy`: []

#### Direct only, not transitive (current behavior)

Today, dependency queries show **direct neighbors only**. Querying T008 shows `dependsOn: [T001]` but does NOT automatically reveal that T004 is further upstream. An agent would need to manually follow the chain: check T008, see T001, check T001, see T004.

This matters for LLM agents, which may not think to traverse deeper. An agent assigned T008 might try to work on T001 without realizing T001 is itself blocked by T004.

#### Planned: summary hints (progressive disclosure)

To solve this without dumping full graphs on every query, the dependency response should include computed hints:

| Field | Purpose | Example |
|-------|---------|---------|
| `dependsOn` | Direct dependencies (existing) | `[T001]` |
| `dependedOnBy` | Direct dependents (existing) | `[]` |
| `unresolvedChain` | Count of unresolved tasks in the full upstream chain | `2` |
| `leafBlockers` | The root-cause tasks at the bottom of the chain with no deps of their own (or all deps satisfied) | `[T004]` |
| `allDepsReady` | Whether all transitive deps are resolved (existing) | `false` |

This gives agents the answer to "what actually needs to happen first?" (`leafBlockers`) without requiring them to traverse manually, and the `unresolvedChain` count tells an orchestrator "this is deep, don't assign it yet" without the full tree.

A full transitive tree view should be available on demand (`ct deps --tree T008`) for orchestrators or humans who need the complete picture.

> **Dev note**: Stored in a separate `task_dependencies` junction table (`task_id`, `depends_on`), not on the task row itself. Both columns reference `tasks(id) ON DELETE CASCADE`. Circular check in `src/core/tasks/dependency-check.ts`. Completion enforcement in `src/core/tasks/complete.ts`. Both-direction query in `coreTaskDeps()` at `src/core/tasks/task-ops.ts`. `leafBlockers` and `unresolvedChain` are not yet implemented -- tracked for future work.

### `relates` (non-blocking relations)

Cross-references between tasks that don't block anything. Used for provenance tracking and navigation.

Three relation types in the database:

| Type | Meaning |
|------|---------|
| `related` | General connection (default) |
| `blocks` | Informational "this blocks that" note (softer than `depends`) |
| `duplicates` | This task is a duplicate of another |

The legacy JSON schema also defined `relates-to`, `spawned-from`, `deferred-to`, and `supersedes` as relation types, which may still appear in older data.

```bash
ct update T015 --relates T020
ct update T015 --relates T020:duplicates
```

> **Dev note**: Stored in `task_relations` junction table (`task_id`, `related_to`, `relation_type`). The `relates` field is not on the base `Task` TypeScript interface -- it's attached as an extension in `src/core/tasks/relates.ts`.

### `blockedBy` (free-text blocker explanation)

A human-readable string explaining **why** a task is blocked. **Required** when `status` is set to `blocked`. Setting status to `blocked` without providing `blockedBy` will fail validation.

```bash
# This works:
ct update T001 --status blocked --blocked-by "Waiting for design mockups from client"

# This fails:
ct update T001 --status blocked
# Error: blocked task(s) missing blockedBy reason
```

This is completely separate from `depends`. You can have:
- `status: blocked` + `blockedBy: "Waiting on API key"` -- manual external blocker, no task dependency
- `status: pending` + `depends: ['T005']` -- has a task dependency but isn't marked as blocked
- Both at the same time -- blocked by an external reason AND has task dependencies

> **Dev note**: Column `blocked_by TEXT`. Max 300 chars. Enforced in two places: (1) JSON schema `if/then` rule requires `blockedBy` when `status = 'blocked'`, and (2) `validate-ops.ts` flags blocked tasks missing `blockedBy` as errors during `ct validate`.

---

## Content Fields

### `notes`

An append-only implementation log. Each entry is a timestamped note about progress, decisions, or discoveries. Once added, notes are never deleted or edited.

```bash
ct update T001 --notes "Discovered the redirect happens in middleware, not the route handler"
ct update T001 --notes "Fixed by checking req.session.returnTo before defaulting to /dashboard"
```

> **Dev note**: Column `notes_json TEXT DEFAULT '[]'`. Stored as a JSON array of strings. Max 5000 chars per entry. Append-only by convention.

### `acceptance` (acceptance criteria)

A list of testable conditions that define "done." The task is complete when ALL criteria are met. Think of these as a checklist.

```bash
ct add "Add search feature" --acceptance "Returns results within 200ms,Handles empty queries gracefully,Results are paginated"
```

> **Dev note**: Column `acceptance_json TEXT DEFAULT '[]'`. JSON array, max 200 chars per item, `minItems: 1` if field is present.

### `files` (linked files)

Relative file paths (from project root) that this task will create or modify. Useful for planning and tracking scope.

```bash
ct add "Refactor auth module" --files "src/auth/login.ts,src/auth/middleware.ts,src/auth/__tests__/login.test.ts"
```

> **Dev note**: Column `files_json TEXT DEFAULT '[]'`. JSON array of strings. No path format validation beyond being strings.

### `labels`

Tags for filtering and organizing tasks. Must be lowercase alphanumeric with dots and hyphens.

```bash
ct add "Fix CSS layout" --labels "frontend,css,bug"
ct find --label frontend
```

> **Dev note**: Column `labels_json TEXT DEFAULT '[]'`. Pattern `^[a-z][a-z0-9.-]*$`. Must be unique within the array.

---

## Lifecycle & Provenance

### `phase`

Assigns a task to a project phase. Phases are defined in the project configuration and represent high-level milestones (e.g. `alpha`, `beta`, `v1`).

```bash
ct update T001 --phase beta
```

> **Dev note**: Column `phase TEXT`. Must match a key in `project.phases`. Pattern `^[a-z][a-z0-9-]*$`.

### `epicLifecycle`

A high-level lifecycle state for epics only. Separate from task `status` -- this tracks the epic's progression through planning stages.

| State | Meaning |
|-------|---------|
| `backlog` | Identified but not yet planned |
| `planning` | Being decomposed into tasks |
| `active` | Tasks are being worked on |
| `review` | All tasks done, reviewing the whole |
| `released` | Shipped |
| `archived` | Moved to cold storage |

```bash
ct update T001 --epic-lifecycle active
```

> **Dev note**: Column `epic_lifecycle TEXT`. Only meaningful when `type = 'epic'`. This is separate from the RCASD pipeline (see Lifecycle Pipeline below).

### `origin`

Where the task came from. Useful for metrics and triage.

| Origin | Meaning |
|--------|---------|
| `internal` | Identified by the team |
| `bug-report` | From a bug report |
| `feature-request` | From a feature request |
| `security` | Security issue |
| `technical-debt` | Code quality improvement |
| `dependency` | Driven by a dependency update |
| `regression` | Something that used to work broke |

> **Dev note**: Column `origin TEXT`, nullable.

### `noAutoComplete`

When `true`, the epic/task will NOT auto-complete when all its children are done. Requires explicit manual completion. Useful for epics that need a final review or release step after all subtasks finish.

```bash
ct update T001 --no-auto-complete
```

> **Dev note**: Column `no_auto_complete INTEGER` (SQLite boolean). Checked in `src/core/tasks/complete.ts`.

### Provenance fields: `createdBy`, `modifiedBy`, `sessionId`

Track which agent or user created/modified a task and in which session.

| Field | Example value |
|-------|---------------|
| `createdBy` | `user`, `system`, `implementation-agent-T5001` |
| `modifiedBy` | `user`, `testing-agent-T5002` |
| `sessionId` | Session ID that last touched this task |

> **Dev note**: Stored as `TaskProvenance` object in the `provenance` field, or as individual columns `created_by`, `modified_by`, `session_id`.

---

## Verification (Multi-Agent Review)

The `verification` object tracks whether a task's implementation has been reviewed and approved across multiple quality gates. This is primarily used in multi-agent workflows where different agents handle different review responsibilities.

### Gates

| Gate | Responsible agent | Question it answers |
|------|-------------------|---------------------|
| `implemented` | `coder` | Did the coder complete the implementation? |
| `testsPassed` | `testing` | Do all tests pass? |
| `qaPassed` | `qa` | Do acceptance criteria pass? |
| `cleanupDone` | `cleanup` | Is the code clean and refactored? |
| `securityPassed` | `security` | Are there no critical security issues? |
| `documented` | `docs` | Is documentation complete? |

Each gate is `true` (passed), `false` (failed), or `null` (not yet checked).

### Other verification fields

| Field | Meaning |
|-------|---------|
| `passed` | `true` only when ALL required gates pass |
| `round` | Current implementation round (0 = not started). Increments on each fix-and-retry cycle. |
| `lastAgent` | Which agent last updated verification |
| `lastUpdated` | When verification was last updated |
| `failureLog` | Array of `{ round, agent, reason, timestamp }` entries logging each failure |

> **Dev note**: Stored as JSON in `verification_json TEXT` column. TypeScript type `TaskVerification` in `src/types/task.ts`.

---

## Timestamps

| Field | When it's set | Required? |
|-------|---------------|-----------|
| `createdAt` | Automatically on task creation | Yes (auto) |
| `updatedAt` | Automatically on every mutation | No (auto) |
| `completedAt` | When status changes to `done` | Required when `done` |
| `cancelledAt` | When status changes to `cancelled` | Required when `cancelled` |

All timestamps are ISO 8601 format. Anti-hallucination validation rejects timestamps more than 5 minutes in the future.

> **Dev note**: `cancellationReason` (column `cancellation_reason TEXT`, 5-300 chars) is also required when `status = 'cancelled'`. Must not contain shell metacharacters.

---

## Lifecycle Pipeline (RCASD)

Separate from task fields, the lifecycle pipeline is a structured workflow that tracks an epic through formalized stages. It uses its own database tables and is attached to a task (usually an epic) via `task_id`.

### Pipeline stages (in order)

| # | Stage | Purpose |
|---|-------|---------|
| 1 | `research` | Information gathering |
| 2 | `consensus` | Multi-agent agreement on approach |
| 3 | `architecture_decision` | ADR creation |
| 4 | `specification` | Write the spec |
| 5 | `decomposition` | Break into tasks |
| 6 | `implementation` | Write the code |
| 7 | `validation` | Static analysis, type checking |
| 8 | `testing` | Run tests, check coverage |
| 9 | `release` | Version, tag, publish |

Plus `contribution` as a cross-cutting stage for attribution tracking.

### Stage statuses

Each stage independently tracks: `not_started`, `in_progress`, `blocked`, `completed`, `skipped`, `failed`.

### Gates

Each stage can have gate checks that produce results: `pass`, `fail`, or `warn`. Gates are checked by agents or tooling and recorded with who checked them and when.

### Evidence

Stages can have evidence attached (files, URLs, or manifest entries) to prove work was done.

### Transitions

Movement between stages is logged as `automatic`, `manual`, or `forced`.

> **Dev note**: Five tables: `lifecycle_pipelines`, `lifecycle_stages`, `lifecycle_gate_results`, `lifecycle_evidence`, `lifecycle_transitions`. All defined in `src/store/schema.ts`. Core logic in `src/core/lifecycle/`.

---

## Quick Reference: "Blocked" in CLEO

Because "blocked" shows up in multiple places:

| Mechanism | What it is | Automatic? | Enforced? |
|-----------|-----------|------------|-----------|
| `status: 'blocked'` + `blockedBy` | Manual flag with free-text reason | No, you set it | No enforcement, just status |
| `depends: ['T005']` | Task dependency graph | Enforced at completion time | Yes -- can't complete until deps done |
| `ct plan` "blocked" section | Display grouping for tasks with unresolved deps | Yes (computed) | No -- just display |
| Lifecycle stage `status: 'blocked'` | Stage-level block in RCASD pipeline | Set by agents | Pipeline-specific |

---

## Field Summary Table

| Field | Type | Required | Set via |
|-------|------|----------|---------|
| `id` | `string` | Auto | Auto-generated |
| `title` | `string` | Yes | `ct add "title"` |
| `description` | `string` | Recommended | `--description` |
| `status` | enum | Yes (default: `pending`) | `ct start`, `ct done`, `ct update --status` |
| `priority` | enum | Yes (default: `medium`) | `--priority` |
| `type` | enum | No (default: `task`) | `--type` |
| `parentId` | `string` | No | `--parent T001` |
| `size` | enum | No | `--size` |
| `phase` | `string` | No | `--phase` |
| `depends` | `string[]` | No | `--depends T001,T002` |
| `relates` | relation objects | No | `--relates T003` |
| `blockedBy` | `string` | When `status=blocked` | `--blocked-by "reason"` |
| `acceptance` | `string[]` | No | `--acceptance "criteria1,criteria2"` |
| `files` | `string[]` | No | `--files "path1,path2"` |
| `notes` | `string[]` | No | `--notes "note text"` |
| `labels` | `string[]` | No | `--labels "tag1,tag2"` |
| `origin` | enum | No | `--origin` |
| `epicLifecycle` | enum | No (epics only) | `--epic-lifecycle` |
| `noAutoComplete` | `boolean` | No | `--no-auto-complete` |
| `verification` | object | No | Set by agents |
| `provenance` | object | No | Auto-tracked |
